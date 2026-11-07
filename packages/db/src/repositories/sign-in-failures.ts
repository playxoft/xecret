import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { signInFailures } from '../schema/identity';
import type { Executor } from './shared';

/**
 * Failed in-app sign-ins per address (migration 0034). The policy — how many
 * failures are free, how the lockout grows, its ceiling — is the caller's
 * (`apps/web/src/server/sign-in-throttle.ts`); this module only counts and
 * stores, so "how long is somebody locked out" has one definition, tested
 * without a database.
 *
 * Every function takes the SHA-256 of the lower-cased address, never the
 * address: the table is written for addresses nobody owns as readily as for
 * real ones, and must not become a list of every address somebody tried.
 */

export interface SignInFailureState {
  /** Consecutive failures in the current window. */
  failedAttempts: number;
  /** When the lockout they earned ends, or `null`. */
  lockedUntil: Date | null;
}

/** What is recorded against an address, or `null` when nothing is. Reads only. */
export async function findSignInFailures(
  exec: Executor,
  subjectHash: Uint8Array,
): Promise<SignInFailureState | null> {
  const [row] = await exec
    .select({
      failedAttempts: signInFailures.failedAttempts,
      lockedUntil: signInFailures.lockedUntil,
    })
    .from(signInFailures)
    .where(eq(signInFailures.subjectHash, subjectHash))
    .limit(1);
  return row ?? null;
}

/**
 * Counts one failed sign-in against an address, atomically, and records the
 * lockout the new count earns.
 *
 * The count is `+ 1` in SQL, never a value the caller read and wrote back: two
 * concurrent wrong guesses read the same count, and a read-then-write would
 * record one — which is the whole of what an attacker spraying in parallel
 * wants. A failure after `windowStart` adds to the count; the first one after
 * a quiet window starts it again at one, so last month's typos are not held
 * against today. The lockout is computed by `lockoutFor` from the count the
 * database returned, and only ever lengthens one that is already standing.
 */
export async function recordSignInFailure(
  exec: Executor,
  params: {
    subjectHash: Uint8Array;
    now: Date;
    windowStart: Date;
    lockoutFor: (failedAttempts: number, now: Date) => Date | null;
  },
): Promise<SignInFailureState> {
  const { subjectHash, now, windowStart } = params;
  return exec.transaction(async (tx) => {
    const [row] = await tx
      .insert(signInFailures)
      .values({ subjectHash, failedAttempts: 1, lastFailedAt: now })
      .onConflictDoUpdate({
        target: signInFailures.subjectHash,
        set: {
          failedAttempts: sql`case
            when ${signInFailures.lastFailedAt} < ${windowStart.toISOString()}::timestamptz then 1
            else ${signInFailures.failedAttempts} + 1
          end`,
          lastFailedAt: now,
        },
      })
      .returning({
        failedAttempts: signInFailures.failedAttempts,
        lockedUntil: signInFailures.lockedUntil,
      });
    if (!row) return { failedAttempts: 0, lockedUntil: null };

    const earned = params.lockoutFor(row.failedAttempts, now);
    if (earned === null || (row.lockedUntil !== null && row.lockedUntil >= earned)) {
      return row;
    }
    await tx
      .update(signInFailures)
      .set({ lockedUntil: earned })
      .where(eq(signInFailures.subjectHash, subjectHash));
    return { failedAttempts: row.failedAttempts, lockedUntil: earned };
  });
}

/** A success: the slate is wiped. */
export async function clearSignInFailures(exec: Executor, subjectHash: Uint8Array): Promise<void> {
  await exec.delete(signInFailures).where(eq(signInFailures.subjectHash, subjectHash));
}

/**
 * Deletes the rows that can no longer hold anybody back: last failure before
 * `before`, and no lockout still running at `now`. For the scheduled worker.
 */
export async function pruneSignInFailures(
  exec: Executor,
  params: { before: Date; now: Date },
): Promise<number> {
  const rows = await exec
    .delete(signInFailures)
    .where(
      and(
        lt(signInFailures.lastFailedAt, params.before),
        or(isNull(signInFailures.lockedUntil), lt(signInFailures.lockedUntil, params.now)),
      ),
    )
    .returning({ failedAttempts: signInFailures.failedAttempts });
  return rows.length;
}
