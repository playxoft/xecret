import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashToken } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  consumeReauthProof,
  findFreshSignIn,
  issueReauthProof,
  markReauthCodeSent,
  recordFreshSignIn,
  recordReauthMfaPending,
  reserveReauthGuess,
} from './reauth';

/**
 * The vault reset's re-authentication record (migration 0019), against a real
 * database — every guarantee here is a predicate meeting a row.
 *
 * The web layer's suite (`apps/web/src/server/reauth.test.ts`) drives these
 * through the routes. This one pins what the routes cannot reach on their own:
 * each binding in each predicate separately, even where another binding would
 * catch the same request today; the guess budgets under concurrency; and the
 * table's own constraints.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  t.reset();
});

const PER_ATTEMPT = 5;
const PER_USER = 10;
const minutes = (n: number) => n * 60_000;
const since = (n: number) => new Date(Date.now() - minutes(n));

async function userWithSession(userId: string = randomUUID()) {
  const sessionId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email) values ($1, $2, $3) on conflict (id) do nothing`,
    [
      userId,
      `user_01${userId.replaceAll('-', '').slice(0, 20)}`,
      `r-${userId.slice(0, 8)}@example.com`,
    ],
  );
  await t.pg.query(
    `insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, userId, await hashToken(randomUUID())],
  );
  return { userId, sessionId };
}

/** A fresh sign-in on a new session, with its code requested. */
async function liveAttempt(userId?: string) {
  const who = await userWithSession(userId);
  await recordFreshSignIn(t.db, { ...who, at: new Date() });
  const row = await findFreshSignIn(t.db, {
    ...who,
    signedInSince: since(10),
    maxAttempts: PER_ATTEMPT,
  });
  await markReauthCodeSent(t.db, row!.id, new Date());
  return { ...who, attemptId: row!.id };
}

const reserve = (who: { userId: string; sessionId: string }) =>
  reserveReauthGuess(t.db, {
    userId: who.userId,
    sessionId: who.sessionId,
    signedInSince: since(10),
    maxAttempts: PER_ATTEMPT,
    maxUserAttempts: PER_USER,
    userWindowSince: since(24 * 60),
  });

async function attemptsOf(sessionId: string): Promise<number> {
  const result = await t.pg.query<{ code_attempts: number }>(
    `select code_attempts from reauthentications where session_id = $1`,
    [sessionId],
  );
  return result.rows[0]?.code_attempts ?? -1;
}

async function attemptWithProof(now = new Date()) {
  const who = await liveAttempt();
  const proofHash = await hashToken(`xrp_live_${randomUUID()}`);
  const issued = await issueReauthProof(t.db, {
    userId: who.userId,
    sessionId: who.sessionId,
    signedInSince: new Date(now.getTime() - minutes(10)),
    proofHash,
    expiresAt: new Date(now.getTime() + minutes(5)),
  });
  expect(issued).toBe(true);
  return { ...who, proofHash };
}

describe('reserving a guess', () => {
  it('takes one guess per call and stops at the attempt’s own cap', async () => {
    const who = await liveAttempt();

    for (let i = 1; i <= PER_ATTEMPT; i += 1) {
      expect(await reserve(who)).toMatchObject({ ok: true });
      expect(await attemptsOf(who.sessionId)).toBe(i);
    }
    expect(await reserve(who)).toEqual({ ok: false, reason: 'no-attempt' });
    expect(await attemptsOf(who.sessionId)).toBe(PER_ATTEMPT);
  });

  it('refuses a guess on an attempt whose code was never requested', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });

    expect(await reserve(who)).toEqual({ ok: false, reason: 'no-attempt' });
    expect(await attemptsOf(who.sessionId)).toBe(0);
  });

  it('refuses a guess once the sign-in has aged out, or the attempt was spent', async () => {
    const old = await userWithSession();
    await recordFreshSignIn(t.db, { ...old, at: new Date(Date.now() - minutes(11)) });
    await t.pg.query(`update reauthentications set code_sent_at = now() where session_id = $1`, [
      old.sessionId,
    ]);
    expect(await reserve(old)).toEqual({ ok: false, reason: 'no-attempt' });

    const spent = await attemptWithProof();
    await consumeReauthProof(t.db, { ...spent, now: new Date() });
    expect(await reserve(spent)).toEqual({ ok: false, reason: 'no-attempt' });
  });

  it('names the user and the session it reserves against', async () => {
    const who = await liveAttempt();

    expect(await reserve({ ...who, userId: randomUUID() })).toMatchObject({ ok: false });
    expect(await reserve({ ...who, sessionId: randomUUID() })).toMatchObject({ ok: false });
    expect(await attemptsOf(who.sessionId)).toBe(0);
  });

  it('holds the per-attempt cap under a burst of concurrent guesses', async () => {
    const who = await liveAttempt();

    const results = await Promise.all(Array.from({ length: 30 }, () => reserve(who)));

    expect(results.filter((r) => r.ok)).toHaveLength(PER_ATTEMPT);
    expect(await attemptsOf(who.sessionId)).toBe(PER_ATTEMPT);
  });

  it('does not reset with a fresh sign-in: the user’s budget spans every attempt in the window', async () => {
    const userId = randomUUID();
    let granted = 0;
    for (let round = 0; round < 4; round += 1) {
      const who = await liveAttempt(userId);
      for (let i = 0; i < PER_ATTEMPT + 1; i += 1) if ((await reserve(who)).ok) granted += 1;
    }

    expect(granted).toBe(PER_USER);
    const last = await liveAttempt(userId);
    expect(await reserve(last)).toEqual({ ok: false, reason: 'user-budget' });
  });

  it('holds the per-user cap under concurrent guesses from several sessions of one account', async () => {
    const userId = randomUUID();
    const first = await liveAttempt(userId);
    const others = await Promise.all(Array.from({ length: 3 }, () => liveAttempt(userId)));

    const results = await Promise.all(
      [first, ...others].flatMap((who) => Array.from({ length: PER_ATTEMPT }, () => reserve(who))),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(PER_USER);
  });

  it('forgets guesses older than the window', async () => {
    const userId = randomUUID();
    const old = await liveAttempt(userId);
    await t.pg.query(
      `update reauthentications set code_attempts = $2, signed_in_at = now() - interval '25 hours' where session_id = $1`,
      [old.sessionId, PER_USER],
    );

    expect(await reserve(await liveAttempt(userId))).toMatchObject({ ok: true });
  });
});

describe('finding the fresh sign-in', () => {
  it('names the user as well as the session, and ends with the attempt’s guesses', async () => {
    const who = await liveAttempt();
    const params = { signedInSince: since(10), maxAttempts: PER_ATTEMPT };

    expect(await findFreshSignIn(t.db, { ...who, ...params })).not.toBeNull();
    expect(await findFreshSignIn(t.db, { ...who, userId: randomUUID(), ...params })).toBeNull();
    expect(await findFreshSignIn(t.db, { ...who, sessionId: randomUUID(), ...params })).toBeNull();

    for (let i = 0; i < PER_ATTEMPT; i += 1) await reserve(who);
    expect(await findFreshSignIn(t.db, { ...who, ...params })).toBeNull();
  });
});

describe('the authenticator step', () => {
  it('records the pending token’s hash and factor, and hands them back on the next reservation', async () => {
    const who = await liveAttempt();
    const pendingHash = await hashToken('pending-token');

    const recorded = await recordReauthMfaPending(t.db, {
      id: who.attemptId,
      pendingHash,
      factorId: 'auth_factor_01',
    });
    const next = await reserve(who);

    expect(recorded).toBe(true);
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(Buffer.from(next.attempt.mfaPendingHash!)).toEqual(Buffer.from(pendingHash));
      expect(next.attempt.mfaFactorId).toBe('auth_factor_01');
    }
  });

  it('is cleared by the proof it leads to', async () => {
    const who = await liveAttempt();
    await recordReauthMfaPending(t.db, {
      id: who.attemptId,
      pendingHash: await hashToken('p'),
      factorId: 'auth_factor_01',
    });

    await issueReauthProof(t.db, {
      userId: who.userId,
      sessionId: who.sessionId,
      signedInSince: since(10),
      proofHash: await hashToken('xrp_live_x'),
      expiresAt: new Date(Date.now() + minutes(5)),
    });

    const row = await t.pg.query<{ mfa_pending_hash: Uint8Array | null }>(
      `select mfa_pending_hash from reauthentications where id = $1`,
      [who.attemptId],
    );
    expect(row.rows[0]?.mfa_pending_hash).toBeNull();
  });
});

describe('minting a proof', () => {
  const mint = (who: { userId: string; sessionId: string }) =>
    issueReauthProof(t.db, {
      userId: who.userId,
      sessionId: who.sessionId,
      signedInSince: since(10),
      proofHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
      expiresAt: new Date(Date.now() + minutes(5)),
    });

  it('names the user and the session it is minted for', async () => {
    const who = await liveAttempt();

    expect(await mint({ ...who, userId: randomUUID() })).toBe(false);
    expect(await mint({ ...who, sessionId: randomUUID() })).toBe(false);
    expect(await mint(who)).toBe(true);
  });

  it('is refused once the sign-in has aged out', async () => {
    const who = await liveAttempt();
    await t.pg.query(
      `update reauthentications set signed_in_at = now() - interval '11 minutes' where session_id = $1`,
      [who.sessionId],
    );

    expect(await mint(who)).toBe(false);
  });

  it('is refused on an attempt whose code was never requested', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });

    expect(await mint(who)).toBe(false);
  });

  it('is refused for an attempt already spent', async () => {
    const { userId, sessionId, proofHash } = await attemptWithProof();
    await consumeReauthProof(t.db, { userId, sessionId, proofHash, now: new Date() });

    expect(await mint({ userId, sessionId })).toBe(false);
  });
});

describe('spending a proof', () => {
  it('names the user as well as the session — the session alone is not trusted to imply it', async () => {
    const { sessionId, proofHash } = await attemptWithProof();

    expect(
      await consumeReauthProof(t.db, {
        userId: randomUUID(),
        sessionId,
        proofHash,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('names the session as well as the user', async () => {
    const { userId, proofHash } = await attemptWithProof();

    expect(
      await consumeReauthProof(t.db, {
        userId,
        sessionId: randomUUID(),
        proofHash,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it('spends once, and not after expiry', async () => {
    const { userId, sessionId, proofHash } = await attemptWithProof();
    const later = new Date(Date.now() + minutes(6));
    const spend = (now: Date) => consumeReauthProof(t.db, { userId, sessionId, proofHash, now });

    expect(await spend(later)).toBe(false);
    expect(await spend(new Date())).toBe(true);
    expect(await spend(new Date())).toBe(false);
  });
});

describe('the table', () => {
  it('holds SHA-256 digests and nothing else in its hash columns', async () => {
    const who = await userWithSession();
    const raw = new TextEncoder().encode('xrp_live_raw_proof');
    await expect(
      t.pg.query(
        `insert into reauthentications (id, user_id, session_id, signed_in_at, proof_hash, proof_expires_at)
         values ($1, $2, $3, now(), $4, now())`,
        [randomUUID(), who.userId, who.sessionId, raw],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.pg.query(
        `insert into reauthentications (id, user_id, session_id, signed_in_at, mfa_pending_hash, mfa_factor_id)
         values ($1, $2, $3, now(), $4, 'f')`,
        [randomUUID(), who.userId, who.sessionId, raw],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never holds a proof without an expiry, a spent attempt without a proof, or half an MFA step', async () => {
    const cases: Array<[string, unknown]> = [
      ['proof_hash', await hashToken('p')],
      ['used_at', new Date()],
      ['mfa_pending_hash', await hashToken('p')],
      ['mfa_factor_id', 'auth_factor_01'],
    ];
    for (const [column, value] of cases) {
      const who = await userWithSession();
      await expect(
        t.pg.query(
          `insert into reauthentications (id, user_id, session_id, signed_in_at, ${column})
           values ($1, $2, $3, now(), $4)`,
          [randomUUID(), who.userId, who.sessionId, value],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('allows one attempt per session', async () => {
    const who = await userWithSession();
    await recordFreshSignIn(t.db, { ...who, at: new Date() });

    await expect(recordFreshSignIn(t.db, { ...who, at: new Date() })).rejects.toThrow();
  });

  it('keeps an attempt whose session is revoked, and drops it when the session row is deleted', async () => {
    // Sessions are revoked by UPDATE. The row staying is harmless: spending its
    // proof needs a request authenticated by that session, which a revoked
    // session cannot make.
    const { sessionId } = await attemptWithProof();

    await t.pg.query(`update sessions set revoked_at = now() where id = $1`, [sessionId]);
    const kept = await t.pg.query(`select 1 from reauthentications where session_id = $1`, [
      sessionId,
    ]);
    expect(kept.rows).toHaveLength(1);

    await t.pg.query(`delete from sessions where id = $1`, [sessionId]);
    const left = await t.pg.query(`select 1 from reauthentications where session_id = $1`, [
      sessionId,
    ]);
    expect(left.rows).toHaveLength(0);
  });
});
