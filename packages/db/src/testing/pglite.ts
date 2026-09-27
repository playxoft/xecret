import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { QueryOptions, Results, Transaction } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../client';
import * as schema from '../schema';

/**
 * A real PostgreSQL for repository tests: PGlite (Postgres compiled to WASM,
 * in-process, no server), with every migration in `migrations/` applied by
 * Drizzle's own migrator — the same journal, the same statement splitting, the
 * same single transaction `npm run db:migrate` uses.
 *
 * ── Why this exists ──
 * The rest of this package's tests inspect generated SQL without a database,
 * which proves a predicate is *present* and nothing about whether it *works*.
 * For most queries that is a fair trade. For the identity linking pass it is
 * not: a recording fake that ignored WHERE clauses passed every test with the
 * soft-delete filter deleted, with the "still unlinked" guard replaced by
 * `true`, and with a race loser handed the row it had lost — each of them an
 * account takeover. Those are properties of predicates evaluated against rows,
 * so they are tested against rows.
 *
 * ── Test-only ──
 * `@electric-sql/pglite` is a devDependency and this module is not exported
 * from the package. Keep one instance per test file (`beforeAll`) and give each
 * test its own addresses and ids rather than truncating between tests: WASM
 * start-up and nineteen migrations cost about a second, a fresh row costs
 * nothing.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/** One statement as it reached PGlite. */
export interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

export interface TestDatabase {
  /**
   * The repositories' `Executor`, backed by PGlite.
   *
   * Typed as the production `Database` because `Executor` names the postgres.js
   * driver's result type. The query builders the repositories use — select,
   * insert, update, `returning` — are the same `PgDatabase` code under either
   * driver and map rows identically; what differs is only the raw result of
   * `db.execute(sql)`, which none of the code under test here calls.
   */
  db: Database;
  /** The PGlite instance itself, for fixtures and for reading rows back raw. */
  pg: PGlite;
  /** Every statement `db` has issued, in order. Clear it with `.length = 0`. */
  statements: RecordedStatement[];
  /**
   * Runs `hook` immediately before the next INSERT or UPDATE that `db` issues,
   * then lets that write proceed.
   *
   * This is how a test places a concurrent request *exactly* between another
   * request's read and its write — the window every race in the linking pass
   * lives in — without depending on timing. The hook may itself call the
   * repositories through `db`; it is disarmed before it runs, so it does not
   * fire on its own writes.
   */
  beforeNextWrite(hook: () => Promise<unknown>): void;
  close(): Promise<void>;
}

/**
 * The hook timeout for a `beforeAll` that calls `createTestDatabase`.
 *
 * Starting PGlite and applying every migration takes about a second alone, but
 * well over vitest's 10s default when `npm test` runs every workspace's files
 * in parallel on a busy machine — and a suite that fails only under load is a
 * suite people learn to rerun rather than read.
 */
export const TEST_DATABASE_TIMEOUT_MS = 60_000;

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create({ extensions: { citext } });
  await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_FOLDER });

  const statements: RecordedStatement[] = [];
  let pendingHook: (() => Promise<unknown>) | undefined;

  // The narrow surface drizzle's PGlite session calls: `query` for every
  // statement, `transaction` for `db.transaction`. Statements inside a
  // transaction go to PGlite's own transaction handle and are not recorded —
  // nothing under test here opens one.
  const client = {
    async query<T>(query: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> {
      statements.push({ sql: query, params: params ?? [] });
      if (pendingHook && /^\s*(insert|update)\b/i.test(query)) {
        const hook = pendingHook;
        pendingHook = undefined;
        await hook();
      }
      return pg.query<T>(query, params, options);
    },
    transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
      return pg.transaction(run);
    },
  };

  const db = drizzle({ client: client as unknown as PGlite, schema }) as unknown as Database;

  return {
    db,
    pg,
    statements,
    beforeNextWrite(hook) {
      pendingHook = hook;
    },
    close: () => pg.close(),
  };
}
