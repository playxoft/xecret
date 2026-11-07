import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  clearSignInFailures,
  findSignInFailures,
  pruneSignInFailures,
  recordSignInFailure,
} from './sign-in-failures';

/**
 * The durable sign-in failure counter (migration 0034): that a failure is
 * counted once however many arrive at once, that a quiet window starts the
 * count again, that a lockout only ever lengthens, and that the prune takes
 * only rows that can no longer hold anybody back. The policy that turns a
 * count into a lockout is the web app's, and is passed in.
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
/** A distinct 32-byte subject per call. */
function subject(): Uint8Array {
  sequence += 1;
  const bytes = new Uint8Array(32);
  bytes[0] = sequence & 0xff;
  bytes[1] = (sequence >> 8) & 0xff;
  return bytes;
}

const NOW = new Date('2026-11-08T10:00:00Z');
const WINDOW_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const never = () => null;

describe('recordSignInFailure', () => {
  it('starts a row at one and counts each failure after it', async () => {
    const who = subject();

    await recordSignInFailure(t.db, {
      subjectHash: who,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: never,
    });
    const second = await recordSignInFailure(t.db, {
      subjectHash: who,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: never,
    });

    expect(second).toEqual({ failedAttempts: 2, lockedUntil: null });
    expect(await findSignInFailures(t.db, who)).toEqual({ failedAttempts: 2, lockedUntil: null });
  });

  it('counts every one of a burst of concurrent failures — no lost update', async () => {
    const who = subject();

    await Promise.all(
      Array.from({ length: 12 }, () =>
        recordSignInFailure(t.db, {
          subjectHash: who,
          now: NOW,
          windowStart: WINDOW_START,
          lockoutFor: never,
        }),
      ),
    );

    expect((await findSignInFailures(t.db, who))?.failedAttempts).toBe(12);
  });

  it('starts the count again after a quiet window', async () => {
    const who = subject();
    const long = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < 4; i += 1) {
      await recordSignInFailure(t.db, {
        subjectHash: who,
        now: long,
        windowStart: new Date(long.getTime() - 24 * 60 * 60 * 1000),
        lockoutFor: never,
      });
    }

    const next = await recordSignInFailure(t.db, {
      subjectHash: who,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: never,
    });

    expect(next.failedAttempts).toBe(1);
  });

  it('records the lockout the count earns, and never shortens one already running', async () => {
    const who = subject();
    const far = new Date(NOW.getTime() + 15 * 60 * 1000);
    const near = new Date(NOW.getTime() + 30 * 1000);

    const first = await recordSignInFailure(t.db, {
      subjectHash: who,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: () => far,
    });
    const second = await recordSignInFailure(t.db, {
      subjectHash: who,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: () => near,
    });

    expect(first.lockedUntil).toEqual(far);
    expect(second.lockedUntil).toEqual(far);
    expect((await findSignInFailures(t.db, who))?.lockedUntil).toEqual(far);
  });

  it('passes the policy the count the database returned', async () => {
    const who = subject();
    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await recordSignInFailure(t.db, {
        subjectHash: who,
        now: NOW,
        windowStart: WINDOW_START,
        lockoutFor: (n) => {
          seen.push(n);
          return null;
        },
      });
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it('refuses a subject that is not a 32-byte hash', async () => {
    await expect(
      recordSignInFailure(t.db, {
        subjectHash: new Uint8Array(16),
        now: NOW,
        windowStart: WINDOW_START,
        lockoutFor: never,
      }),
    ).rejects.toThrow();
  });
});

describe('clearSignInFailures', () => {
  it('wipes the slate for one address and no other', async () => {
    const who = subject();
    const other = subject();
    for (const s of [who, other]) {
      await recordSignInFailure(t.db, {
        subjectHash: s,
        now: NOW,
        windowStart: WINDOW_START,
        lockoutFor: never,
      });
    }

    await clearSignInFailures(t.db, who);

    expect(await findSignInFailures(t.db, who)).toBeNull();
    expect(await findSignInFailures(t.db, other)).not.toBeNull();
  });
});

describe('pruneSignInFailures', () => {
  it('deletes rows past their window with no lockout running, and keeps the rest', async () => {
    const old = subject();
    const oldButLocked = subject();
    const recent = subject();
    const long = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    await recordSignInFailure(t.db, {
      subjectHash: old,
      now: long,
      windowStart: WINDOW_START,
      lockoutFor: never,
    });
    await recordSignInFailure(t.db, {
      subjectHash: oldButLocked,
      now: long,
      windowStart: WINDOW_START,
      lockoutFor: () => new Date(NOW.getTime() + 60_000),
    });
    await recordSignInFailure(t.db, {
      subjectHash: recent,
      now: NOW,
      windowStart: WINDOW_START,
      lockoutFor: never,
    });

    const pruned = await pruneSignInFailures(t.db, { before: WINDOW_START, now: NOW });

    expect(pruned).toBe(1);
    expect(await findSignInFailures(t.db, old)).toBeNull();
    expect(await findSignInFailures(t.db, oldButLocked)).not.toBeNull();
    expect(await findSignInFailures(t.db, recent)).not.toBeNull();
  });
});
