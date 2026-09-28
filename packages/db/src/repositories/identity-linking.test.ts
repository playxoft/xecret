import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IdentityVerificationError, isWorkosIdentity, workosIdentity } from '@xecret/core/auth';
import type { VerifiedIdentity, WorkosIdentity } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { ArmedHook, TestDatabase } from '../testing/pglite';
import { RepositoryError } from './shared';
import {
  findUserByFirebaseUid,
  findUserByWorkosId,
  isSameAddress,
  isUniqueViolation,
  upsertUserFromFirebaseIdentity,
  upsertUserFromWorkosIdentity,
} from './users';

/**
 * The identity-linking pass, which is the account-takeover surface of the whole
 * provider migration — and the Firebase upsert it must never be confused with.
 *
 * `.local/workos-auth.md` §5 gives the normative order: provider id, then
 * **verified** email, then create. The second step is the one that carries
 * every pre-existing account across the swap without anybody noticing, and the
 * one that hands an account to a stranger if it is wrong.
 *
 * ── Against a real database, deliberately ──
 * Every test here runs the real function against PostgreSQL (PGlite) with the
 * real migrations applied, and asserts on the rows. An earlier version drove a
 * recording fake that ignored WHERE predicates, and it passed with the
 * soft-delete filter removed, with the "still unlinked" guard replaced by
 * `true`, and with a race loser handed the row it had lost. Each of those is an
 * account takeover, and each is a property of a predicate meeting a row.
 *
 * Races are placed deterministically: `beforeNextWrite` runs a second request
 * to completion in the exact window between the first request's reads and its
 * write, and `beforeNextStatement` in the window between two of its reads.
 * Every race test asserts its hook fired — a race that never happened passes
 * vacuously.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

// Disarms any hook a previous test armed but never reached, and clears the
// statement log.
beforeEach(() => {
  t.reset();
});

/* ── fixtures ───────────────────────────────────────────────────────────── */

let sequence = 0;

/** A fresh address per call, so no test sees another's rows. */
function address(label = 'person'): string {
  sequence += 1;
  return `${label}-${sequence}-${randomUUID().slice(0, 8)}@example.com`;
}

/** A fresh, well-formed WorkOS user id (`user_` + alphanumerics). */
function workosId(): string {
  sequence += 1;
  return `user_01T${sequence}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Seconds since the epoch — the unit `authTime` is carried in. */
const AUTH_TIME = Math.floor(Date.parse('2026-09-23T10:00:00.000Z') / 1000);

function identity(over: Partial<VerifiedIdentity> = {}): WorkosIdentity {
  return workosIdentity({
    subject: workosId(),
    email: address(),
    emailVerified: true,
    displayName: 'Alice',
    authTime: AUTH_TIME,
    ...over,
  });
}

function firebaseIdentity(over: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    subject: `fb${randomUUID().replaceAll('-', '').slice(0, 26)}`,
    email: address('firebase'),
    emailVerified: true,
    displayName: 'Firebase Person',
    authTime: AUTH_TIME,
    ...over,
  };
}

interface RawUser {
  id: string;
  firebase_uid: string | null;
  workos_user_id: string | null;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  last_login_at: Date | null;
  deleted_at: Date | null;
}

/** A Firebase-era account: a `firebase_uid`, no WorkOS id yet. */
async function seedFirebaseUser(
  over: { email?: string; deleted?: boolean; workosUserId?: string | null } = {},
): Promise<RawUser> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, firebase_uid, workos_user_id, email, email_verified, display_name, deleted_at)
     values ($1, $2, $3, $4, true, 'Seeded', $5)`,
    [
      id,
      `fb-${id}`,
      over.workosUserId ?? null,
      over.email ?? address('seeded'),
      over.deleted ? new Date() : null,
    ],
  );
  return (await raw(id))!;
}

async function raw(id: string): Promise<RawUser | undefined> {
  const result = await t.pg.query<RawUser>(
    `select id, firebase_uid, workos_user_id, email::text as email, display_name, avatar_url,
            last_login_at, deleted_at
       from users where id = $1`,
    [id],
  );
  return result.rows[0];
}

async function usersWith(column: 'email' | 'workos_user_id' | 'firebase_uid', value: string) {
  const result = await t.pg.query<RawUser>(
    `select id, firebase_uid, workos_user_id, email::text as email, deleted_at
       from users where ${column} = $1`,
    [value],
  );
  return result.rows;
}

async function softDelete(id: string): Promise<void> {
  await t.pg.query(`update users set deleted_at = now() where id = $1`, [id]);
}

/** Resolves to the error a promise rejects with; fails the test if it resolves. */
async function refusal(promise: Promise<unknown>): Promise<RepositoryError> {
  const outcome = await promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if ('value' in outcome) {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
  }
  expect(outcome.error).toBeInstanceOf(RepositoryError);
  return outcome.error as RepositoryError;
}

const writes = () => t.statements.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.sql));

/* ───────────────────────────────────────────────────────────────────────────
 * Rule 4. The one that matters most.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('an unverified email is refused before anything else happens', () => {
  it('refuses as forbidden without issuing a single statement', async () => {
    // The whole attack: register an unverified `someone@company.com` at the
    // identity provider and be handed that person's existing xecret account,
    // with its organisations, its grants and its secrets. The refusal is the
    // first thing in the function precisely so that no query can precede it —
    // including the email lookup that would perform the takeover.
    const victim = await seedFirebaseUser();
    t.statements.length = 0;

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: victim.email, emailVerified: false })),
    );

    expect(error.code).toBe('forbidden');
    expect(t.statements, 'a query ran before the verification check').toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The three steps, in order.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('step 1 — a known provider id', () => {
  it('is an ordinary login into the same row, mirroring the profile but not the name', async () => {
    const first = await upsertUserFromWorkosIdentity(t.db, identity());

    const again = await upsertUserFromWorkosIdentity(
      t.db,
      workosIdentity({
        subject: first.user.workosUserId!,
        email: first.user.email,
        emailVerified: true,
        displayName: 'Renamed Upstream',
        avatarUrl: 'https://example.com/a.png',
        authTime: AUTH_TIME,
      }),
    );

    expect(again.outcome).toBe('matched');
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.avatarUrl).toBe('https://example.com/a.png');
    // The account owns its display name once the row exists.
    expect(again.user.displayName).toBe('Alice');
  });

  it('follows an address changed upstream (rule 5)', async () => {
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    const renamed = address('renamed');

    const again = await upsertUserFromWorkosIdentity(
      t.db,
      identity({ subject: first.user.workosUserId!, email: renamed }),
    );

    expect(again.outcome).toBe('matched');
    expect(again.user.id).toBe(first.user.id);
    expect((await raw(first.user.id))?.email).toBe(renamed);
  });

  it('never adopts by email once the identity is known: a change onto a taken address is a conflict', async () => {
    // Step 2 is the dangerous one. An identity that already has a row must not
    // enter it — here, that would move the identity onto the other account.
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    const other = await seedFirebaseUser();

    const error = await refusal(
      upsertUserFromWorkosIdentity(
        t.db,
        identity({ subject: first.user.workosUserId!, email: other.email }),
      ),
    );

    expect(error.code).toBe('conflict');
    expect(await raw(other.id)).toEqual(other);
    expect((await raw(first.user.id))?.email).toBe(first.user.email);
  });

  it('refuses a soft-deleted account as deleted, even under a new address', async () => {
    // Filtered out, the deleted row would look like nobody, and step 3 would
    // mint a fresh account for the same identity — reviving by the back door.
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    await softDelete(first.user.id);
    const subject = first.user.workosUserId!;

    for (const email of [first.user.email, address('after-deletion')]) {
      const error = await refusal(upsertUserFromWorkosIdentity(t.db, identity({ subject, email })));
      expect(error.code).toBe('notFound');
    }

    expect(await usersWith('workos_user_id', subject)).toHaveLength(1);
    expect((await raw(first.user.id))?.deleted_at).not.toBeNull();
  });

  it("does not let a deleted account's identity adopt another account by email", async () => {
    // The identity is terminal with its account. Read past, it would fall
    // through to step 2 and try to move onto whichever account holds the
    // address it now presents.
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    await softDelete(first.user.id);
    const other = await seedFirebaseUser();
    t.statements.length = 0;

    const error = await refusal(
      upsertUserFromWorkosIdentity(
        t.db,
        identity({ subject: first.user.workosUserId!, email: other.email }),
      ),
    );

    expect(error.code).toBe('notFound');
    expect(writes()).toHaveLength(0);
    expect(await raw(other.id)).toEqual(other);
  });

  it('refuses when the account is deleted between the read and the write', async () => {
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    const race = t.beforeNextWrite(() => softDelete(first.user.id));

    const error = await refusal(
      upsertUserFromWorkosIdentity(
        t.db,
        identity({ subject: first.user.workosUserId!, email: first.user.email }),
      ),
    );

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('notFound');
  });

  it('refuses when the row stops carrying this identity between the read and the write', async () => {
    // Nothing in the application unlinks a row, but the sign-in write still
    // re-asserts the identity it was decided on rather than trusting the read.
    const first = await upsertUserFromWorkosIdentity(t.db, identity());
    const race = t.beforeNextWrite(() =>
      t.pg.query(`update users set workos_user_id = $2 where id = $1`, [first.user.id, workosId()]),
    );

    const error = await refusal(
      upsertUserFromWorkosIdentity(
        t.db,
        identity({ subject: first.user.workosUserId!, email: first.user.email }),
      ),
    );

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(/no longer linked/);
    expect((await raw(first.user.id))?.last_login_at).toEqual(first.user.lastLoginAt);
  });
});

describe('findUserByWorkosId', () => {
  it('resolves an active account by its WorkOS id', async () => {
    const created = await upsertUserFromWorkosIdentity(t.db, identity());

    expect((await findUserByWorkosId(t.db, created.user.workosUserId!))?.id).toBe(created.user.id);
  });

  it('does not resolve a soft-deleted account', async () => {
    const created = await upsertUserFromWorkosIdentity(t.db, identity());
    await softDelete(created.user.id);

    expect(await findUserByWorkosId(t.db, created.user.workosUserId!)).toBeNull();
  });

  it('resolves nothing for an id nobody holds', async () => {
    expect(await findUserByWorkosId(t.db, workosId())).toBeNull();
  });
});

describe('step 2 — a known address, adopted', () => {
  it('adopts a pre-existing account and reports it as a link, not a login', async () => {
    // This is the migration working. Every account that existed before the
    // provider swap arrives here exactly once, and the distinct outcome is what
    // lets the caller audit the moment an account changed providers.
    const seeded = await seedFirebaseUser();
    const who = identity({ email: seeded.email });

    const result = await upsertUserFromWorkosIdentity(t.db, who);

    expect(result.outcome).toBe('linked');
    expect(result.user.id).toBe(seeded.id);
    const after = await raw(seeded.id);
    expect(after?.workos_user_id).toBe(who.subject);
    // The rollback column survives the link untouched.
    expect(after?.firebase_uid).toBe(seeded.firebase_uid);
    expect((await findUserByFirebaseUid(t.db, seeded.firebase_uid!))?.id).toBe(seeded.id);
  });

  it('links once: the next sign-in is an ordinary login', async () => {
    const seeded = await seedFirebaseUser();
    const who = identity({ email: seeded.email });
    await upsertUserFromWorkosIdentity(t.db, who);

    const again = await upsertUserFromWorkosIdentity(t.db, who);

    expect(again.outcome).toBe('matched');
    expect(again.user.id).toBe(seeded.id);
  });

  it('is reached by the same address in a different ASCII case', async () => {
    // `email` is citext, so the database does the folding for the lookup.
    const seeded = await seedFirebaseUser({ email: address('Mixed.Case') });

    const result = await upsertUserFromWorkosIdentity(
      t.db,
      identity({ email: seeded.email.toUpperCase() }),
    );

    expect(result.outcome).toBe('linked');
    expect(result.user.id).toBe(seeded.id);
  });

  it('refuses an address already bound to a different identity, and writes nothing', async () => {
    // Two provider identities claiming one account is either a provider bug or
    // an attack. Adopting the newer one hands the account over.
    const seeded = await seedFirebaseUser({ workosUserId: workosId() });
    t.statements.length = 0;

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: seeded.email })),
    );

    expect(error.code).toBe('conflict');
    expect(writes()).toHaveLength(0);
    expect(await raw(seeded.id)).toEqual(seeded);
  });

  it('does not adopt a soft-deleted account: refused as deleted, nothing written', async () => {
    const seeded = await seedFirebaseUser({ deleted: true });
    t.statements.length = 0;

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: seeded.email })),
    );

    expect(error.code).toBe('notFound');
    expect(writes(), 'the refusal must precede every write').toHaveLength(0);
    expect(await raw(seeded.id)).toEqual(seeded);
    expect(await usersWith('email', seeded.email)).toHaveLength(1);
  });

  it('does not adopt an account deleted between the read and the write, and says why', async () => {
    const seeded = await seedFirebaseUser();
    const race = t.beforeNextWrite(() => softDelete(seeded.id));

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: seeded.email })),
    );

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('notFound');
    expect(error.message).not.toMatch(/different identity/);
    expect((await raw(seeded.id))?.workos_user_id).toBeNull();
    // Terminal on the spot: a deletion is not the "address moved" case, so the
    // pass does not start over — the address was looked up exactly once.
    expect(t.statements.filter((s) => /where "users"\."email" = /.test(s.sql))).toHaveLength(1);
  });

  it('two identities racing for one account: exactly one wins, the loser is refused', async () => {
    // The loser read the row while it was unlinked, and must not be answered
    // from that stale read — returning it would sign the loser into an account
    // that now belongs to the winner.
    const seeded = await seedFirebaseUser();
    const winner = identity({ email: seeded.email });
    const loser = identity({ email: seeded.email });
    let winnerResult: Awaited<ReturnType<typeof upsertUserFromWorkosIdentity>> | undefined;

    const race = t.beforeNextWrite(async () => {
      winnerResult = await upsertUserFromWorkosIdentity(t.db, winner);
    });
    const error = await refusal(upsertUserFromWorkosIdentity(t.db, loser));

    expect(race.fired()).toBe(true);
    expect(winnerResult?.outcome).toBe('linked');
    expect(error.code).toBe('conflict');
    // And told the real reason, decided from the re-read row — not refused by
    // some later check for a reason that happens to share the code.
    expect(error.message).toMatch(/already linked to a different identity/);
    expect((await raw(seeded.id))?.workos_user_id).toBe(winner.subject);
    expect(await usersWith('workos_user_id', loser.subject)).toHaveLength(0);
  });

  it('the same identity racing itself: one link, and the other is a login', async () => {
    const seeded = await seedFirebaseUser();
    const who = identity({ email: seeded.email });
    let first: Awaited<ReturnType<typeof upsertUserFromWorkosIdentity>> | undefined;

    const race = t.beforeNextWrite(async () => {
      first = await upsertUserFromWorkosIdentity(t.db, who);
    });
    const second = await upsertUserFromWorkosIdentity(t.db, who);

    expect(race.fired()).toBe(true);
    expect(first?.outcome).toBe('linked');
    // Not `linked` again: that would audit one adoption twice.
    expect(second.outcome).toBe('matched');
    expect(second.user.id).toBe(seeded.id);
  });

  it('answers a lost workos_user_id race as a conflict, not a 500', async () => {
    // The same identity signing in twice at once under two addresses: one
    // request adopts an existing account, the other creates one. Whichever
    // writes second hits `users_workos_user_id_unique`.
    const seeded = await seedFirebaseUser();
    const subject = workosId();

    const race = t.beforeNextWrite(() =>
      upsertUserFromWorkosIdentity(t.db, identity({ subject, email: address('parallel') })),
    );
    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ subject, email: seeded.email })),
    );

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(/identity is already linked to another account/);
    expect((await raw(seeded.id))?.workos_user_id).toBeNull();
  });

  it('a concurrent sign-in of this identity linking the row between the two reads is a login', async () => {
    // The window between step 1's lookup by identity (nothing yet) and step
    // 2's lookup by address, where the other request lands its link. The row
    // step 2 then finds already carries this identity: an ordinary login, not
    // "linked to a different identity".
    const seeded = await seedFirebaseUser();
    const who = identity({ email: seeded.email });
    let first: Awaited<ReturnType<typeof upsertUserFromWorkosIdentity>> | undefined;

    const race = t.beforeNextStatement(/^select .* where "users"\."email" = /s, async () => {
      first = await upsertUserFromWorkosIdentity(t.db, who);
    });
    const second = await upsertUserFromWorkosIdentity(t.db, who);

    expect(race.fired()).toBe(true);
    expect(first?.outcome).toBe('linked');
    expect(second.outcome).toBe('matched');
    expect(second.user.id).toBe(seeded.id);
  });

  it('does not adopt an account whose address moved away mid-write: starts over with the address as it now is', async () => {
    // Between the read and the write, the account's owner changes their
    // address at Firebase. The row is no longer the account for the address
    // being presented; adopting it would hand the account to whoever holds the
    // old address, and write the old address back over the new one.
    const seeded = await seedFirebaseUser();
    const moved = address('moved-to');
    const who = identity({ email: seeded.email });

    const race = t.beforeNextWrite(() =>
      upsertUserFromFirebaseIdentity(
        t.db,
        firebaseIdentity({ subject: seeded.firebase_uid!, email: moved }),
      ),
    );
    const result = await upsertUserFromWorkosIdentity(t.db, who);

    expect(race.fired()).toBe(true);
    // The retry found the address unheld, so it is a new account's.
    expect(result.outcome).toBe('created');
    expect(result.user.id).not.toBe(seeded.id);
    const after = await raw(seeded.id);
    expect(after?.email).toBe(moved);
    expect(after?.workos_user_id).toBeNull();
  });

  it('starts over once, then refuses with a conflict that names the real cause', async () => {
    // Two accounts in a row lose the address being presented, each inside the
    // window of the attempt that was about to adopt it. Not worth chasing: the
    // second loss is refused — accurately, not as "a different identity".
    const firstHolder = await seedFirebaseUser();
    const secondHolder = await seedFirebaseUser();
    const presented = firstHolder.email;
    let retryRace: ArmedHook | undefined;

    const race = t.beforeNextWrite(async () => {
      await t.pg.query(`update users set email = $2 where id = $1`, [
        firstHolder.id,
        address('away-1'),
      ]);
      await t.pg.query(`update users set email = $2 where id = $1`, [secondHolder.id, presented]);
      retryRace = t.beforeNextWrite(() =>
        t.pg.query(`update users set email = $2 where id = $1`, [
          secondHolder.id,
          address('away-2'),
        ]),
      );
    });
    const error = await refusal(upsertUserFromWorkosIdentity(t.db, identity({ email: presented })));

    expect(race.fired()).toBe(true);
    expect(retryRace?.fired()).toBe(true);
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(/changed while this sign-in was in progress/);
    expect((await raw(firstHolder.id))?.workos_user_id).toBeNull();
    expect((await raw(secondHolder.id))?.workos_user_id).toBeNull();
  });
});

describe('step 2 — only the same address is adopted', () => {
  it('does not adopt on a non-ASCII address, even one the database calls equal', async () => {
    // citext folds with `lower()`, which under a UTF-8 locale is Unicode case
    // mapping. Adoption is restricted to what can be decided exactly, so a
    // non-ASCII address skips it, and the insert is refused by the unique
    // constraint — a conflict for a human, never a silent adoption.
    const seeded = await seedFirebaseUser({
      email: `jürgen-${randomUUID().slice(0, 8)}@example.com`,
    });

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: seeded.email })),
    );

    expect(error.code).toBe('conflict');
    expect(await raw(seeded.id)).toEqual(seeded);
  });

  it.each([
    ['identical', 'kelly@example.com', 'kelly@example.com', true],
    ['ASCII case only', 'Kelly@Example.COM', 'kelly@example.com', true],
    [
      'Kelvin sign (U+212A) folds to k under Unicode lower()',
      'kelly@example.com',
      'Kelly@example.com',
      false,
    ],
    [
      'dotted capital I (U+0130) folds to i under glibc lower()',
      'ian@example.com',
      'İan@example.com',
      false,
    ],
    ['stored side non-ASCII', 'Kelly@example.com', 'kelly@example.com', false],
    ['identical but non-ASCII', 'jürgen@example.com', 'jürgen@example.com', false],
    ['whitespace', ' kelly@example.com', 'kelly@example.com', false],
  ])('isSameAddress: %s', (_label, stored, presented, expected) => {
    expect(isSameAddress(stored, presented)).toBe(expected);
  });
});

describe('step 3 — nobody at all', () => {
  it('creates the account with the WorkOS id and no Firebase id', async () => {
    // A user who signs up after the swap never had a Firebase account. Writing
    // a synthetic value would put a lie into the one column the rollback
    // depends on being true.
    const who = identity();

    const result = await upsertUserFromWorkosIdentity(t.db, who);

    expect(result.outcome).toBe('created');
    const row = await raw(result.user.id);
    expect(row?.workos_user_id).toBe(who.subject);
    expect(row?.firebase_uid).toBeNull();
    expect(row?.display_name).toBe('Alice');
  });

  it('refuses an address held by a deleted, never-linked account as deleted — not as a conflict', async () => {
    // Steps 1 and 2 find no *active* holder, so without looking at deleted
    // rows the insert collides with `users_email_unique` and the caller is told
    // "conflict" (or, unmapped, a 500) for what is really a deletion.
    const seeded = await seedFirebaseUser({ deleted: true });

    const error = await refusal(
      upsertUserFromWorkosIdentity(t.db, identity({ email: seeded.email })),
    );

    expect(error.code).toBe('notFound');
    expect(await usersWith('email', seeded.email)).toHaveLength(1);
  });

  it('two first logins of one identity: one account, one "created", one "matched"', async () => {
    // A cold start plus a double-clicked button. Reporting `created` twice
    // would audit two sign-ups for one account.
    const who = identity();
    let first: Awaited<ReturnType<typeof upsertUserFromWorkosIdentity>> | undefined;

    const race = t.beforeNextWrite(async () => {
      first = await upsertUserFromWorkosIdentity(t.db, who);
    });
    const second = await upsertUserFromWorkosIdentity(t.db, who);

    expect(race.fired()).toBe(true);
    expect(first?.outcome).toBe('created');
    expect(second.outcome).toBe('matched');
    expect(second.user.id).toBe(first?.user.id);
    expect(await usersWith('workos_user_id', who.subject)).toHaveLength(1);
  });

  it('refuses when the row a concurrent sign-in created is deleted before this one reads it back', async () => {
    // The loser of the step-3 race re-reads the winner's row and signs into
    // it. If that account was deleted in between, it is deleted — the re-read
    // row is not a login to hand back as it stands.
    const who = identity();
    const race = t.beforeNextWrite(async () => {
      const winner = await upsertUserFromWorkosIdentity(t.db, who);
      await softDelete(winner.user.id);
    });

    const error = await refusal(upsertUserFromWorkosIdentity(t.db, who));

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('notFound');
  });

  it('two identities claiming one new address: one account, the other refused', async () => {
    const email = address('contested');
    const winner = identity({ email });
    const loser = identity({ email });

    const race = t.beforeNextWrite(() => upsertUserFromWorkosIdentity(t.db, winner));
    const error = await refusal(upsertUserFromWorkosIdentity(t.db, loser));

    expect(race.fired()).toBe(true);
    expect(error.code).toBe('conflict');
    const rows = await usersWith('email', email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workos_user_id).toBe(winner.subject);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The Firebase upsert — what `POST /api/auth/session` runs until WS-2.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('the Firebase upsert', () => {
  it('creates on firebase_uid and never writes workos_user_id', async () => {
    const who = firebaseIdentity();

    const user = await upsertUserFromFirebaseIdentity(t.db, who);

    const row = await raw(user.id);
    expect(row?.firebase_uid).toBe(who.subject);
    expect(row?.workos_user_id).toBeNull();
    // Keyed on the Firebase column: the upsert's arbiter is `firebase_uid`.
    expect(t.statements.at(-1)?.sql).toContain('on conflict ("firebase_uid")');
    expect((await findUserByFirebaseUid(t.db, who.subject))?.id).toBe(user.id);
  });

  it('resolves an existing Firebase account by uid and leaves its WorkOS column alone', async () => {
    const seeded = await seedFirebaseUser();

    const user = await upsertUserFromFirebaseIdentity(
      t.db,
      firebaseIdentity({ subject: seeded.firebase_uid!, email: seeded.email }),
    );

    expect(user.id).toBe(seeded.id);
    expect((await raw(seeded.id))?.workos_user_id).toBeNull();
  });

  it('follows an address changed at Firebase on the same account', async () => {
    const seeded = await seedFirebaseUser();
    const renamed = address('fb-renamed');

    const user = await upsertUserFromFirebaseIdentity(
      t.db,
      firebaseIdentity({ subject: seeded.firebase_uid!, email: renamed }),
    );

    expect(user.id).toBe(seeded.id);
    expect(await usersWith('email', renamed)).toHaveLength(1);
  });

  it('never matches by email: a different Firebase uid on a taken address is a conflict', async () => {
    const seeded = await seedFirebaseUser();

    const error = await refusal(
      upsertUserFromFirebaseIdentity(t.db, firebaseIdentity({ email: seeded.email })),
    );

    expect(error.code).toBe('conflict');
    expect(await raw(seeded.id)).toEqual(seeded);
  });

  it('refuses a soft-deleted account with notFound', async () => {
    const seeded = await seedFirebaseUser({ deleted: true });

    const error = await refusal(
      upsertUserFromFirebaseIdentity(
        t.db,
        firebaseIdentity({ subject: seeded.firebase_uid!, email: seeded.email }),
      ),
    );

    expect(error.code).toBe('notFound');
    expect(await raw(seeded.id)).toEqual(seeded);
  });

  it('keeps a WorkOS link written earlier', async () => {
    // During the transition a person can be linked by WorkOS and still sign in
    // through the old route; the old route must not undo the link.
    const seeded = await seedFirebaseUser();
    const who = identity({ email: seeded.email });
    await upsertUserFromWorkosIdentity(t.db, who);

    await upsertUserFromFirebaseIdentity(
      t.db,
      firebaseIdentity({ subject: seeded.firebase_uid!, email: seeded.email }),
    );

    expect((await raw(seeded.id))?.workos_user_id).toBe(who.subject);
  });
});

describe('the two upserts cannot be handed each other’s identity', () => {
  it('is a compile error in both directions (checked by `tsc`, which covers this file)', () => {
    // The live Firebase route was once wired to the WorkOS linker, and nothing
    // objected because both took a plain `VerifiedIdentity`. These closures
    // are never called; the `@ts-expect-error` lines are the assertions, and
    // `npm run typecheck` fails if any of them stops being an error.
    const fromFirebase = firebaseIdentity();
    const fromWorkos = identity();

    // @ts-expect-error — a Firebase identity is not WorkOS-attested.
    void (() => upsertUserFromWorkosIdentity(t.db, fromFirebase));
    // @ts-expect-error — nor is one with the discriminant pasted on.
    void (() => upsertUserFromWorkosIdentity(t.db, { ...fromFirebase, provider: 'workos' }));
    // @ts-expect-error — a WorkOS identity must not reach the Firebase upsert.
    void (() => upsertUserFromFirebaseIdentity(t.db, fromWorkos));

    expect(fromWorkos.provider).toBe('workos');
  });

  it('refuses an `as`-cast Firebase identity at runtime too, before any query', async () => {
    await expect(
      upsertUserFromWorkosIdentity(t.db, firebaseIdentity() as unknown as WorkosIdentity),
    ).rejects.toBeInstanceOf(TypeError);
    expect(t.statements).toHaveLength(0);
  });

  it('the Firebase upsert refuses a WorkOS identity at runtime, before any query', async () => {
    await expect(
      upsertUserFromFirebaseIdentity(t.db, identity() as unknown as VerifiedIdentity),
    ).rejects.toBeInstanceOf(TypeError);
    expect(t.statements).toHaveLength(0);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The brand is checked at runtime, because `any` is not checked at all.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('the brand holds at runtime, not only in the type', () => {
  it('refuses a JSON round-trip of a genuine identity — what a parsed request body is', async () => {
    // `JSON.parse` returns `any`, which satisfies `WorkosIdentity` with no cast
    // at all. The copy carries `provider: 'workos'` and a valid subject; what it
    // lacks is having been minted by `workosIdentity()`.
    const victim = await seedFirebaseUser();
    const body = JSON.stringify(identity({ email: victim.email }));

    // Passed straight through, exactly as a handler would pass `request.json()`.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- `any` is the case under test.
    await expect(upsertUserFromWorkosIdentity(t.db, JSON.parse(body))).rejects.toThrow(
      /did not mint/,
    );

    expect(t.statements).toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });

  it('refuses a forged body with a Firebase-shaped subject, naming the subject', async () => {
    const victim = await seedFirebaseUser();
    const body = JSON.stringify({
      subject: 'Xk3pQ9mZ2vB7nR4tY6wL8sD1fG0h',
      email: victim.email,
      emailVerified: true,
      authTime: AUTH_TIME,
      provider: 'workos',
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- `any` is the case under test.
    await expect(upsertUserFromWorkosIdentity(t.db, JSON.parse(body))).rejects.toThrow(
      /not a WorkOS user id/,
    );

    expect(t.statements).toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });

  it('refuses a spread of a genuine identity with somebody else’s address', async () => {
    // The spread keeps the brand's *type* — TypeScript copies the symbol key —
    // but it is a new object with a new address, and nobody attested to that.
    const victim = await seedFirebaseUser();
    const genuine = identity();
    const respelled = { ...genuine, email: victim.email };

    await expect(upsertUserFromWorkosIdentity(t.db, respelled)).rejects.toThrow(/did not mint/);

    expect(t.statements).toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });

  it('cannot even mint an identity whose emailVerified is not a boolean', async () => {
    // The string "false" is truthy. So is "no", and so is 1. They are refused
    // where the identity is built, so no such object can carry the brand; the
    // linker's own `=== true` check stays as the second layer, and is what the
    // unverified-refusal test above exercises with a real `false`.
    const victim = await seedFirebaseUser();

    for (const emailVerified of ['false', 'true', 1, undefined] as unknown as boolean[]) {
      expect(() => identity({ email: victim.email, emailVerified })).toThrow(
        IdentityVerificationError,
      );
    }

    expect(t.statements).toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });

  it('a polluted Object.prototype cannot supply a verification the input lacked', async () => {
    // The round-3 probe: an input with no own `emailVerified`, and
    // `Object.prototype.emailVerified = true`. Minting refuses it, so nothing
    // reaches the linker and the account whose address it presents is untouched.
    const victim = await seedFirebaseUser();
    const pollutedPrototype = Object.prototype as { emailVerified?: unknown };
    pollutedPrototype.emailVerified = true;
    try {
      expect(() =>
        workosIdentity({
          subject: workosId(),
          email: victim.email,
          authTime: AUTH_TIME,
        } as VerifiedIdentity),
      ).toThrow(IdentityVerificationError);
    } finally {
      delete pollutedPrototype.emailVerified;
    }

    expect(t.statements).toHaveLength(0);
    expect(await raw(victim.id)).toEqual(victim);
  });

  it('mints frozen identities, and only the minted object passes', () => {
    const genuine = identity();

    expect(Object.isFrozen(genuine)).toBe(true);
    expect(isWorkosIdentity(genuine)).toBe(true);
    expect(isWorkosIdentity({ ...genuine })).toBe(false);
    expect(isWorkosIdentity(structuredClone(genuine))).toBe(false);
  });
});

describe('the database refuses an account no provider can reach', () => {
  it('rejects a row with neither provider id (users_identity_present_check)', async () => {
    await expect(
      t.pg.query(`insert into users (id, email) values ($1, $2)`, [randomUUID(), address()]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects anything but a WorkOS id in workos_user_id (users_workos_user_id_format_check)', async () => {
    // The last of three checks of one pattern, and the one a backfill script or
    // a psql session cannot skip.
    for (const bad of ['Xk3pQ9mZ2vB7nR4tY6wL8sD1fG0h', 'user_', 'user_01-ABC', 'org_01ABC']) {
      await expect(
        t.pg.query(`insert into users (id, workos_user_id, email) values ($1, $2, $3)`, [
          randomUUID(),
          bad,
          address(),
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'users_workos_user_id_format_check' });
    }
    const seeded = await seedFirebaseUser();
    await expect(
      t.pg.query(`update users set workos_user_id = $2 where id = $1`, [
        seeded.id,
        seeded.firebase_uid,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * The constraint-violation mapping, for both drivers.
 * ─────────────────────────────────────────────────────────────────────────── */
describe('isUniqueViolation', () => {
  function postgresJsError(constraint: string, code = '23505') {
    // postgres.js — the production driver — names the field `constraint_name`.
    return Object.assign(new Error('duplicate key value'), { code, constraint_name: constraint });
  }
  function pgliteError(constraint: string, code = '23505') {
    return Object.assign(new Error('duplicate key value'), { code, constraint });
  }
  /** How Drizzle surfaces a driver failure: its own error, the driver's as `cause`. */
  function drizzleWrapped(cause: Error) {
    return new Error('Failed query: insert into "users" …', { cause });
  }

  it('recognises the production driver’s error wrapped by Drizzle', () => {
    expect(
      isUniqueViolation(
        drizzleWrapped(postgresJsError('users_email_unique')),
        'users_email_unique',
      ),
    ).toBe(true);
  });

  it('recognises PGlite’s spelling of the same error', () => {
    expect(
      isUniqueViolation(drizzleWrapped(pgliteError('users_email_unique')), 'users_email_unique'),
    ).toBe(true);
  });

  it('does not match a different constraint, a different SQLSTATE, or a non-error', () => {
    for (const error of [
      postgresJsError('users_email_unique'),
      pgliteError('users_email_unique'),
    ]) {
      expect(isUniqueViolation(drizzleWrapped(error), 'users_workos_user_id_unique')).toBe(false);
    }
    expect(
      isUniqueViolation(
        drizzleWrapped(postgresJsError('users_email_unique', '23514')),
        'users_email_unique',
      ),
    ).toBe(false);
    expect(
      isUniqueViolation(
        { code: '23505', constraint_name: 'users_email_unique' },
        'users_email_unique',
      ),
    ).toBe(false);
  });
});
