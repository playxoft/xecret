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
 * ── Test-only, and enforced as such ──
 * Exported as `@xecret/db/testing` so `apps/web` route tests can use it too,
 * but it is test code: `@electric-sql/pglite` is a devDependency, and both
 * lint configs ban importing this module or PGlite from anything that is not a
 * `*.test.ts` file (see `TEST_DATABASE_BAN` in `eslint.config.mjs` and
 * `apps/web/eslint.config.mjs`), so it cannot drift into a runtime bundle.
 *
 * Keep one instance per test file (`beforeAll`, with
 * {@link TEST_DATABASE_TIMEOUT_MS}) and give each test its own addresses and
 * ids rather than truncating between tests: WASM start-up and nineteen
 * migrations cost about a second, a fresh row costs nothing. Call
 * {@link TestDatabase.reset} in `beforeEach` in any file that arms hooks.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/** One statement as it reached PGlite. */
export interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/** What arming a hook hands back, so a race test can prove its race happened. */
export interface ArmedHook {
  /**
   * Whether the hook has run. A race test that never reached its window passes
   * vacuously — it tests the code with no race at all — so every test that
   * arms a hook asserts this.
   */
  fired(): boolean;
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
  /**
   * Every statement `db` has issued, in execution order: a statement is
   * recorded when it is sent, which is *after* any hook armed on it has run, so
   * a hook's own statements come first. Cleared by {@link reset}.
   */
  statements: RecordedStatement[];
  /**
   * Runs `hook` immediately before the next INSERT or UPDATE that `db` issues,
   * then lets that write proceed.
   *
   * This is how a test places a concurrent request *exactly* between another
   * request's read and its write — the window every race in the linking pass
   * lives in — without depending on timing. The hook may itself call the
   * repositories through `db`; it is disarmed before it runs, so it does not
   * fire on its own writes, and it may arm the next hook.
   */
  beforeNextWrite(hook: () => Promise<unknown>): ArmedHook;
  /**
   * Runs `hook` immediately before the next statement whose SQL matches
   * `match`, whatever kind it is — for the windows between two *reads*, such
   * as between the linking pass's lookup by identity and its lookup by address.
   * Same disarming rules as {@link beforeNextWrite}; one hook is armed at a
   * time, and arming replaces any hook still pending.
   */
  beforeNextStatement(match: RegExp, hook: () => Promise<unknown>): ArmedHook;
  /**
   * Disarms any pending hook and clears {@link statements}. A hook armed by a
   * test that never reached its window would otherwise fire inside the *next*
   * test, and fail it for a reason that has nothing to do with it.
   */
  reset(): void;
  close(): Promise<void>;
}

/**
 * The hook timeout for a `beforeAll` that calls `createTestDatabase`.
 *
 * Starting PGlite and applying every migration takes about a second alone.
 * `npm test` runs the workspaces one after another, but vitest runs each
 * workspace's test files in parallel worker processes, one per core — so every
 * PGlite-backed file starts its WASM instance at the same moment as everything
 * else, and on a busy machine that has taken well over vitest's 10s hook
 * default. A suite that fails only under load is a suite people learn to rerun
 * rather than read.
 */
export const TEST_DATABASE_TIMEOUT_MS = 60_000;

const WRITE_STATEMENT = /^\s*(insert|update)\b/i;

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create({ extensions: { citext } });
  await migrate(drizzle({ client: pg }), { migrationsFolder: MIGRATIONS_FOLDER });

  const statements: RecordedStatement[] = [];
  let pending: { match: RegExp; hook: () => Promise<unknown>; fired: boolean } | undefined;

  function arm(match: RegExp, hook: () => Promise<unknown>): ArmedHook {
    const armed = { match, hook, fired: false };
    pending = armed;
    return { fired: () => armed.fired };
  }

  // The narrow surface drizzle's PGlite session calls: `query` for every
  // statement, `transaction` for `db.transaction`. Statements inside a
  // transaction go to PGlite's own transaction handle and are not recorded —
  // nothing under test here opens one.
  const client = {
    async query<T>(query: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> {
      const armed = pending;
      if (armed && armed.match.test(query)) {
        // Disarmed before it runs, so the hook's own statements pass straight
        // through, and the hook is free to arm the next one.
        pending = undefined;
        armed.fired = true;
        await armed.hook();
      }
      // Recorded now, as it is sent — after the hook — so the log is the order
      // the database actually saw.
      statements.push({ sql: query, params: params ?? [] });
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
    beforeNextWrite: (hook) => arm(WRITE_STATEMENT, hook),
    beforeNextStatement: (match, hook) => arm(match, hook),
    reset() {
      pending = undefined;
      statements.length = 0;
    },
    close: () => pg.close(),
  };
}
