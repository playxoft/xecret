import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { hashToken } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import * as schema from '../schema';
import type { Database } from '../client';
import { consumeCliAuthCode, createCliAuthCode, deleteExpiredCliAuthCodes } from './cli-auth';
import { consumePinReset, createPinReset, deleteExpiredPinResets } from './pins';
import {
  createSession,
  deleteExpiredSessions,
  findSessionByTokenHash,
  touchSession,
} from './sessions';

/**
 * One rule, enforced against every query that binds a clock: **no `Date` may
 * reach the driver.**
 *
 * Drizzle's postgres-js driver replaces postgres.js's date serialisers with the
 * identity function — see `construct()` in `drizzle-orm/postgres-js/driver.js` —
 * because it maps dates itself, on the way through a column's encoder. A `Date`
 * that reaches the driver *without* passing through a column therefore has
 * nothing left to convert it: the object arrives at the wire protocol, where
 * `Buffer.byteLength` throws `TypeError: The "string" argument must be of type
 * string`, and the query fails every single time it runs.
 *
 * Which is exactly what shipped. `sql`${column} > ${now}`` reads like the
 * operator form, produces identical SQL, type-checks, and is wrong — and it was
 * written twice, so every PIN reset and every `xecret login` code exchange
 * answered 500. Nothing in review or in the type system distinguishes the two
 * forms, so the distinction is asserted here instead.
 *
 * **What this file proves:** that these calls bind only values the driver can
 * encode, and that the expiry predicates they exist for are still in the SQL.
 * **What it does not prove:** anything about rows. There is no database behind
 * it — the driver records statements and returns nothing — so it says nothing
 * about which rows match, or that PostgreSQL compares the bound timestamp the
 * way the caller intended.
 */

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * A Drizzle database whose driver records statements instead of running them.
 *
 * `options` is present because `drizzle()` writes its date serialisers into it
 * on construction — the very substitution this file exists to defend against.
 */
function recordingDatabase(): { db: Database; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });
      const result = Promise.resolve([]) as Promise<never[]> & { values: () => Promise<never[]> };
      result.values = () => Promise.resolve([]);
      return result;
    },
    begin: <T>(run: (client: unknown) => Promise<T>) => run(client),
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

const NOW = new Date('2026-08-20T06:17:32.445Z');
const USER_ID = uuidv7();
const ORG_ID = uuidv7();

/** Every parameter bound by `run`, flattened across the statements it issued. */
async function boundParams(run: (db: Database) => Promise<unknown>): Promise<unknown[]> {
  const { db, statements } = recordingDatabase();
  await run(db);
  return statements.flatMap((statement) => [...statement.params]);
}

/** The statements `run` issued, for the assertions that are about SQL text. */
async function recorded(run: (db: Database) => Promise<unknown>): Promise<RecordedStatement[]> {
  const { db, statements } = recordingDatabase();
  await run(db);
  return statements;
}

describe('no query hands the driver a Date', () => {
  const calls: Array<[string, (db: Database) => Promise<unknown>]> = [
    [
      'consumePinReset',
      async (db) => consumePinReset(db, await hashToken('xpr_live_example'), NOW),
    ],
    [
      'createPinReset',
      (db) => createPinReset(db, { userId: USER_ID, token: 'xpr_live_example', ipAddress: null }),
    ],
    ['deleteExpiredPinResets', (db) => deleteExpiredPinResets(db, NOW)],
    [
      'consumeCliAuthCode',
      async (db) => consumeCliAuthCode(db, await hashToken('xac_live_example'), NOW),
    ],
    [
      'createCliAuthCode',
      (db) =>
        createCliAuthCode(db, {
          userId: USER_ID,
          orgId: ORG_ID,
          deviceName: 'a laptop',
          codeChallenge: 'challenge',
          ipAddress: null,
        }),
    ],
    ['deleteExpiredCliAuthCodes', (db) => deleteExpiredCliAuthCodes(db, NOW)],
    [
      'findSessionByTokenHash',
      async (db) => findSessionByTokenHash(db, await hashToken('xes_live_example'), NOW),
    ],
    [
      'createSession',
      (db) =>
        createSession(db, {
          userId: USER_ID,
          token: 'xes_live_example',
          ipAddress: null,
          userAgent: null,
        }),
    ],
    ['touchSession', (db) => touchSession(db, uuidv7(), NOW)],
    ['deleteExpiredSessions', (db) => deleteExpiredSessions(db, NOW)],
  ];

  it.each(calls)('%s binds no Date', async (_name, run) => {
    expect((await boundParams(run)).filter((param) => param instanceof Date)).toEqual([]);
  });
});

describe('the single-use credential lookups still compare their expiry', () => {
  /**
   * Paired with the rule above, because there is a way to satisfy that rule that
   * would be far worse than the bug: deleting the comparison. These two
   * predicates are what stop an expired reset link and an expired authorization
   * code from being redeemable.
   */
  it('a PIN reset link is matched only while it is unconsumed and unexpired', async () => {
    const [statement] = await recorded(async (db) =>
      consumePinReset(db, await hashToken('xpr_live_example'), NOW),
    );

    expect(statement?.sql).toMatch(/"consumed_at" is null/);
    expect(statement?.sql).toMatch(/"expires_at" > \$\d+/);
  });

  it('a CLI authorization code is matched only while it is unconsumed and unexpired', async () => {
    const [statement] = await recorded(async (db) =>
      consumeCliAuthCode(db, await hashToken('xac_live_example'), NOW),
    );

    expect(statement?.sql).toMatch(/"consumed_at" is null/);
    expect(statement?.sql).toMatch(/"expires_at" > \$\d+/);
  });
});
