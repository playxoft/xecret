import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

import type { VerifiedIdentity } from '@xecret/core/auth';
import * as schema from '../schema';
import type { Database } from '../client';
import { upsertUserFromIdentity } from './users';
import { RepositoryError } from './shared';

/**
 * The identity-linking pass, which is the account-takeover surface of the whole
 * provider migration.
 *
 * `.local/workos-auth.md` §5 gives the normative order: provider id, then
 * **verified** email, then create. The second step is the one that carries
 * every pre-existing account across the swap without anybody noticing — and the
 * one that hands an account to a stranger if it is wrong.
 *
 * These tests drive the real function against a recording fake that returns
 * scripted rows. They prove the *sequence and its refusals*, which is what is
 * worth proving here; whether the queries filter correctly at the database is
 * the schema's job and integration testing's.
 */

interface Recorded {
  sql: string;
  params: readonly unknown[];
}

/**
 * A database that answers from a script and records what it was asked.
 *
 * `reply` receives the SQL and returns the rows for it, so a test can say "no
 * user has this provider id, but one has this email" — which is the only
 * interesting state in this file.
 */
function fakeDatabase(reply: (sql: string) => unknown[][]): {
  db: Database;
  statements: Recorded[];
} {
  const statements: Recorded[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });
      const rows = reply(sql);
      const result = Promise.resolve(rows) as Promise<unknown[]> & {
        values: () => Promise<unknown[]>;
      };
      result.values = () => Promise.resolve(rows);
      return result;
    },
    begin: <T>(run: (client: unknown) => Promise<T>) => run(client),
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

const WORKOS_ID = 'user_01ABCDEF';
const OTHER_WORKOS_ID = 'user_01ZZZZZZ';
const USER_ID = '0198c0de-0000-7000-8000-000000000001';

function identity(over: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    subject: WORKOS_ID,
    email: 'alice@example.com',
    emailVerified: true,
    displayName: 'Alice',
    avatarUrl: null,
    authTime: new Date('2026-09-23T10:00:00.000Z'),
    ...over,
  } as VerifiedIdentity;
}

/**
 * A `users` row as the driver hands it back — positional, in schema order.
 *
 * Written out rather than built from an object because the fake returns arrays,
 * and a helper that silently reordered the columns would make every assertion
 * in this file agree with the wrong thing.
 */
function userRow(over: { workosUserId?: string | null; firebaseUid?: string | null } = {}) {
  return [
    USER_ID,
    over.firebaseUid ?? null,
    over.workosUserId === undefined ? WORKOS_ID : over.workosUserId,
    'alice@example.com',
    true,
    'Alice',
    null,
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-01-01T00:00:00.000Z'),
    null,
  ];
}

/* ───────────────────────────────────────────────────────────────────────────
 * Rule 4. The one that matters most.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('an unverified email is refused before anything else happens', () => {
  it('refuses, and never reaches the database at all', async () => {
    // The whole attack: register an unverified `someone@company.com` at the
    // identity provider and be handed that person's existing xecret account,
    // with its organisations, its grants and its secrets. The refusal is the
    // first statement in the function precisely so that no query can precede
    // it — including the email lookup that would perform the takeover.
    const { db, statements } = fakeDatabase(() => []);

    await expect(
      upsertUserFromIdentity(db, identity({ emailVerified: false })),
    ).rejects.toBeInstanceOf(RepositoryError);

    expect(statements, 'a query ran before the verification check').toHaveLength(0);
  });

  it('reports it as forbidden, not as a conflict or a missing row', async () => {
    // The code drives the HTTP status. `conflict` would tell the caller to try
    // a different address, and `notFound` would suggest the account is gone —
    // both are wrong advice for somebody who simply has not clicked a link yet.
    const { db } = fakeDatabase(() => []);

    await expect(
      upsertUserFromIdentity(db, identity({ emailVerified: false })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The three steps, in order.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('step 1 — a known provider id', () => {
  it('resolves by provider id and reports an ordinary login', async () => {
    const { db } = fakeDatabase((sql) =>
      sql.includes('"workos_user_id" = ') || sql.startsWith('update') ? [userRow()] : [],
    );

    const result = await upsertUserFromIdentity(db, identity());

    expect(result.outcome).toBe('matched');
    expect(result.user.id).toBe(USER_ID);
  });

  it('never consults email when the provider id already matches', async () => {
    // Step 2 is the dangerous one. A login that has already been identified by
    // provider id must not enter it, or a changed address upstream would start
    // colliding with whoever now holds the old one.
    const { db, statements } = fakeDatabase((sql) =>
      sql.includes('"workos_user_id" = ') || sql.startsWith('update') ? [userRow()] : [],
    );

    await upsertUserFromIdentity(db, identity());

    // A *lookup* by email, specifically. The update in step 1 also writes
    // `email = $n` — mirroring a changed address is rule 5 and is correct — so
    // matching the bare fragment would assert nothing.
    const emailLookup = statements.some(
      (s) => s.sql.startsWith('select') && s.sql.includes('"email" = '),
    );
    expect(emailLookup).toBe(false);
  });
});

describe('step 2 — a known address, adopted', () => {
  /** Nothing matches the provider id; the email lookup finds an unlinked row. */
  function unlinkedByEmail(workosUserId: string | null = null) {
    let emailLookupDone = false;
    return fakeDatabase((sql) => {
      if (sql.includes('"workos_user_id" = ') && sql.startsWith('select')) return [];
      if (sql.includes('"email" = ') && sql.startsWith('select')) {
        emailLookupDone = true;
        return [userRow({ workosUserId, firebaseUid: 'firebase-abc' })];
      }
      if (sql.startsWith('update') && emailLookupDone) {
        return [userRow({ firebaseUid: 'firebase-abc' })];
      }
      return [];
    });
  }

  it('adopts a pre-existing account and reports it as a link, not a login', async () => {
    // This is the migration working. Every account that existed before the
    // provider swap arrives here exactly once, and the distinct outcome is what
    // lets the caller audit it as its own event rather than burying the moment
    // an account changed identity providers inside a routine sign-in.
    const { db } = unlinkedByEmail();

    const result = await upsertUserFromIdentity(db, identity());

    expect(result.outcome).toBe('linked');
  });

  it('writes the provider id onto the row it adopted', async () => {
    const { db, statements } = unlinkedByEmail();

    await upsertUserFromIdentity(db, identity());

    const update = statements.find((s) => s.sql.startsWith('update'));
    expect(update?.params).toContain(WORKOS_ID);
  });

  it('re-asserts "still unlinked, or already ours" in the update predicate', async () => {
    // What makes two concurrent first logins safe. Without it the loser of the
    // race overwrites the link the winner just wrote, and the two sessions end
    // up disagreeing about who the account belongs to.
    const { db, statements } = unlinkedByEmail();

    await upsertUserFromIdentity(db, identity());

    const update = statements.find((s) => s.sql.startsWith('update'));
    expect(update?.sql).toContain('"workos_user_id" is null');
  });

  it('refuses an address already bound to a different identity', async () => {
    // Two provider identities claiming one account is either a provider bug or
    // an attack. Adopting the newer one hands the account over, so the only
    // safe answer is to refuse and let a human look.
    const { db } = unlinkedByEmail(OTHER_WORKOS_ID);

    await expect(upsertUserFromIdentity(db, identity())).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('refuses without writing anything', async () => {
    const { db, statements } = unlinkedByEmail(OTHER_WORKOS_ID);

    await expect(upsertUserFromIdentity(db, identity())).rejects.toBeInstanceOf(RepositoryError);

    expect(statements.some((s) => s.sql.startsWith('update'))).toBe(false);
  });

  it('is reached by the same address in a different case', async () => {
    // `email` is citext, so the database does this. Asserted because the
    // alternative — lowercasing in application code — would suggest the column
    // is case-sensitive and oblige every future call site to remember.
    const { db, statements } = unlinkedByEmail();

    await upsertUserFromIdentity(db, identity({ email: 'ALICE@example.com' }));

    const lookup = statements.find(
      (s) => s.sql.includes('"email" = ') && s.sql.startsWith('select'),
    );
    expect(lookup?.params).toContain('ALICE@example.com');
  });
});

describe('step 3 — nobody at all', () => {
  it('creates the account and says so', async () => {
    const { db } = fakeDatabase((sql) => (sql.startsWith('insert') ? [userRow()] : []));

    const result = await upsertUserFromIdentity(db, identity());

    expect(result.outcome).toBe('created');
  });

  it('writes the provider id and no Firebase id', async () => {
    // A user who signs up after the swap never had a Firebase account. Writing
    // a synthetic value would put a lie into the one column the rollback
    // depends on being true.
    const { db, statements } = fakeDatabase((sql) => (sql.startsWith('insert') ? [userRow()] : []));

    await upsertUserFromIdentity(db, identity());

    const insert = statements.find((s) => s.sql.startsWith('insert'));
    expect(insert?.params).toContain(WORKOS_ID);
    expect(insert?.sql).toContain('"workos_user_id"');
  });

  it('refuses to revive a soft-deleted account', async () => {
    // The provider account may well outlive the xecret one. Silently restoring
    // the row would restore its memberships and grants with it, which is
    // exactly what deleting the account was meant to end. `setWhere` suppresses
    // the update, the insert returns nothing, and that absence is the refusal.
    const { db } = fakeDatabase(() => []);

    await expect(upsertUserFromIdentity(db, identity())).rejects.toMatchObject({
      code: 'notFound',
    });
  });

  it('keeps the soft-delete guard in the statement, not only in the read', async () => {
    const { db, statements } = fakeDatabase((sql) => (sql.startsWith('insert') ? [userRow()] : []));

    await upsertUserFromIdentity(db, identity());

    const insert = statements.find((s) => s.sql.startsWith('insert'));
    expect(insert?.sql).toContain('"deleted_at" is null');
  });
});

describe('the order itself', () => {
  it('asks provider id first, then email — never the reverse', async () => {
    // The order is the security property. Email first would mean an identity
    // that already has a row still gets matched by address, which reopens
    // everything rule 4 closes.
    const { db, statements } = fakeDatabase((sql) => (sql.startsWith('insert') ? [userRow()] : []));

    await upsertUserFromIdentity(db, identity());

    const selects = statements.filter((s) => s.sql.startsWith('select'));
    expect(selects[0]?.sql).toContain('"workos_user_id" = ');
    expect(selects[1]?.sql).toContain('"email" = ');
  });
});
