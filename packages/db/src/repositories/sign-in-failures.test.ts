import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  clearSignInFailures,
  findSignInFailures,
  pruneSignInFailures,
  refundSignInAttempt,
  spendSignInAttempt,
} from './sign-in-failures';
import type { SignInThrottlePolicy } from './sign-in-failures';

/**
 * The sign-in throttle's one statement (migration 0034): an attempt is counted
 * before it is tried, refused while a lockout runs, and opens the next lockout
 * from its own count — so a burst queues on the row and the free budget means
 * exactly what it says. Plus the refund, the clear and the prune.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  t.reset();
  await t.pg.query('delete from sign_in_failures');
});

let sequence = 0;
/** A distinct 32-byte pool key per call. */
function pool(): Uint8Array {
  sequence += 1;
  const bytes = new Uint8Array(32);
  bytes[0] = sequence & 0xff;
  bytes[1] = (sequence >> 8) & 0xff;
  return bytes;
}

const POLICY: SignInThrottlePolicy = {
  freeAttempts: 5,
  baseMs: 30_000,
  maxMs: 15 * 60_000,
  windowMs: 24 * 60 * 60_000,
};
const NOW = new Date('2026-11-08T10:00:00Z');

function spend(subjectHash: Uint8Array, now: Date = NOW) {
  return spendSignInAttempt(t.db, { subjectHash, attemptId: randomUUID(), now, policy: POLICY });
}

describe('spendSignInAttempt', () => {
  it('admits the free attempts with no lockout, and the next one with the first', async () => {
    const who = pool();
    for (let n = 1; n <= POLICY.freeAttempts; n += 1) {
      expect(await spend(who)).toEqual({ admitted: true, failedAttempts: n, lockedUntil: null });
    }

    const sixth = await spend(who);

    expect(sixth.admitted).toBe(true);
    expect(sixth.failedAttempts).toBe(6);
    expect(sixth.lockedUntil).toEqual(new Date(NOW.getTime() + 30_000));
  });

  it('refuses an attempt while a lockout runs, and leaves the row as it was', async () => {
    const who = pool();
    for (let n = 0; n < POLICY.freeAttempts + 1; n += 1) await spend(who);
    const before = await findSignInFailures(t.db, who);

    const refused = await spend(who, new Date(NOW.getTime() + 1_000));

    expect(refused.admitted).toBe(false);
    expect(await findSignInFailures(t.db, who)).toEqual(before);
  });

  it('applies the backoff the web app’s policy describes: 30 s doubling to 15 minutes', async () => {
    const who = pool();
    let at = NOW;
    const delays: number[] = [];
    for (let n = 1; n <= 12; n += 1) {
      const attempt = await spend(who, at);
      expect(attempt.admitted).toBe(true);
      if (attempt.lockedUntil !== null) {
        delays.push(attempt.lockedUntil.getTime() - at.getTime());
        at = attempt.lockedUntil;
      }
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it('admits exactly one of a burst at the end of the free attempts', async () => {
    const who = pool();
    for (let n = 0; n < POLICY.freeAttempts; n += 1) await spend(who);

    const burst = await Promise.all(Array.from({ length: 40 }, () => spend(who)));

    expect(burst.filter((a) => a.admitted)).toHaveLength(1);
    expect((await findSignInFailures(t.db, who))?.failedAttempts).toBe(POLICY.freeAttempts + 1);
  });

  it('admits exactly the free attempts and one more of a burst on a fresh pool', async () => {
    const who = pool();

    const burst = await Promise.all(Array.from({ length: 40 }, () => spend(who)));

    expect(burst.filter((a) => a.admitted)).toHaveLength(POLICY.freeAttempts + 1);
  });

  it('starts the count again after a quiet window', async () => {
    const who = pool();
    const long = new Date(NOW.getTime() - 25 * 60 * 60_000);
    for (let n = 0; n < 4; n += 1) await spend(who, long);

    expect((await spend(who)).failedAttempts).toBe(1);
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(spend(new Uint8Array(16))).rejects.toThrow();
  });

  it('refuses a policy with no free attempt', async () => {
    await expect(
      spendSignInAttempt(t.db, {
        subjectHash: pool(),
        attemptId: randomUUID(),
        now: NOW,
        policy: { ...POLICY, freeAttempts: 0 },
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('refundSignInAttempt', () => {
  it('gives back the count of an attempt never judged, never below zero', async () => {
    const who = pool();
    await spend(who);
    await spend(who);

    await refundSignInAttempt(t.db, who);
    expect((await findSignInFailures(t.db, who))?.failedAttempts).toBe(1);
    await refundSignInAttempt(t.db, who);
    await refundSignInAttempt(t.db, who);
    expect((await findSignInFailures(t.db, who))?.failedAttempts).toBe(0);
  });
});

describe('clearSignInFailures', () => {
  it('wipes the slate for one pool and no other', async () => {
    const who = pool();
    const other = pool();
    await spend(who);
    await spend(other);

    await clearSignInFailures(t.db, who);

    expect(await findSignInFailures(t.db, who)).toBeNull();
    expect(await findSignInFailures(t.db, other)).not.toBeNull();
  });
});

describe('pruneSignInFailures', () => {
  it('deletes rows past their window with no lockout running, keeps the rest, and answers a count', async () => {
    const old = pool();
    const oldButLocked = pool();
    const recent = pool();
    const long = new Date(NOW.getTime() - 25 * 60 * 60_000);
    await spend(old, long);
    await spend(recent);
    await spend(oldButLocked, long);
    await t.pg.query(`update sign_in_failures set locked_until = $2 where subject_hash = $1`, [
      oldButLocked,
      new Date(NOW.getTime() + 60_000),
    ]);

    const pruned = await pruneSignInFailures(t.db, {
      before: new Date(NOW.getTime() - POLICY.windowMs),
      now: NOW,
    });

    expect(pruned).toBe(1);
    expect(await findSignInFailures(t.db, old)).toBeNull();
    expect(await findSignInFailures(t.db, oldButLocked)).not.toBeNull();
    expect(await findSignInFailures(t.db, recent)).not.toBeNull();
  });
});
