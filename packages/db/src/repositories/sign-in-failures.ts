import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { signInFailures } from '../schema/identity';
import type { Executor } from './shared';

/**
 * Sign-in throttle pools (migration 0034): attempts counted against one pool —
 * an address's shared pool, or one known device's — and the lockout they
 * earned. The policy's numbers are the caller's
 * (`apps/web/src/server/sign-in-throttle.ts`), passed in and applied here in
 * SQL, so that counting, refusing and locking are one statement.
 *
 * Every function takes the pool's key — an HMAC the caller computes — never an
 * address.
 */

/** The numbers {@link spendSignInAttempt} applies. */
export interface SignInThrottlePolicy {
  /** Attempts admitted before the first lockout. At least one. */
  freeAttempts: number;
  /** The first lockout, doubling with each admitted attempt after it. */
  baseMs: number;
  /** The ceiling on that doubling. */
  maxMs: number;
  /** An attempt older than this no longer adds to the count. */
  windowMs: number;
}

export interface SignInFailureState {
  /** Attempts counted in the current window. */
  failedAttempts: number;
  /** When the running lockout ends, or `null`. */
  lockedUntil: Date | null;
}

export interface SignInAttempt extends SignInFailureState {
  /** Whether this attempt may go on to ask WorkOS — no lockout was running. */
  admitted: boolean;
}

/**
 * Counts one attempt against a pool **before** it is tried — or refuses it,
 * unchanged, while a lockout is running. One statement, so a burst of
 * concurrent attempts queues on the row and each sees the one before it:
 * every attempt up to `freeAttempts` is admitted, the next is admitted and
 * opens the first lockout, and the rest of the burst find it running.
 *
 * For an admitted attempt the count is `+ 1` (or `1`, after a quiet window),
 * and the lockout it opens is computed from that count: none up to
 * `freeAttempts`, then `baseMs`, doubling, at most `maxMs`. The attempt costs
 * its failure up front — that is the point: a guess that has not been answered
 * yet is still a guess. The caller clears the pool when the credential turns
 * out right ({@link clearSignInFailures}) and refunds an attempt WorkOS never
 * judged ({@link refundSignInAttempt}).
 *
 * `attemptId` (a fresh UUID per attempt) is how the caller learns whether its
 * own attempt was admitted: an admitted one writes it, a refused one leaves
 * the row as it was.
 */
export async function spendSignInAttempt(
  exec: Executor,
  params: {
    subjectHash: Uint8Array;
    attemptId: string;
    now: Date;
    policy: SignInThrottlePolicy;
  },
): Promise<SignInAttempt> {
  const { subjectHash, attemptId, now, policy } = params;
  if (!Number.isSafeInteger(policy.freeAttempts) || policy.freeAttempts < 1) {
    throw new RangeError('A sign-in throttle admits at least one attempt.');
  }
  const at = sql`${now.toISOString()}::timestamptz`;
  const windowStart = sql`${new Date(now.getTime() - policy.windowMs).toISOString()}::timestamptz`;
  const locked = sql`(${signInFailures.lockedUntil} is not null and ${signInFailures.lockedUntil} > ${at})`;
  const counted = sql`(case when ${signInFailures.lastFailedAt} < ${windowStart} then 1 else ${signInFailures.failedAttempts} + 1 end)`;
  const lockoutFrom = (count: SQL) => sql`(case when ${count} > ${policy.freeAttempts}::int
      then ${at} + make_interval(secs => least(
        ${policy.baseMs / 1000}::float8 * power(2::float8, least(${count} - ${policy.freeAttempts}::int - 1, 30)),
        ${policy.maxMs / 1000}::float8))
    end)`;

  const [row] = await exec
    .insert(signInFailures)
    .values({
      subjectHash,
      failedAttempts: 1,
      // The first attempt in a pool is always free (`freeAttempts` ≥ 1).
      lockedUntil: null,
      lastFailedAt: now,
      lastAttemptId: attemptId,
    })
    .onConflictDoUpdate({
      target: signInFailures.subjectHash,
      set: {
        failedAttempts: sql`case when ${locked} then ${signInFailures.failedAttempts} else ${counted} end`,
        lockedUntil: sql`case when ${locked} then ${signInFailures.lockedUntil} else ${lockoutFrom(counted)} end`,
        lastFailedAt: sql`case when ${locked} then ${signInFailures.lastFailedAt} else ${at} end`,
        lastAttemptId: sql`case when ${locked} then ${signInFailures.lastAttemptId} else ${attemptId}::uuid end`,
      },
    })
    .returning({
      failedAttempts: signInFailures.failedAttempts,
      lockedUntil: signInFailures.lockedUntil,
      lastAttemptId: signInFailures.lastAttemptId,
    });
  if (!row) return { admitted: false, failedAttempts: 0, lockedUntil: null };
  return {
    admitted: row.lastAttemptId === attemptId,
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
  };
}

/**
 * Gives back one attempt that was counted but never judged — WorkOS timed out,
 * was unavailable, or asked for a step instead of answering. The count only:
 * a lockout that attempt opened (from the attempt after the free ones) runs
 * out on its own, at most one step of the backoff.
 */
export async function refundSignInAttempt(exec: Executor, subjectHash: Uint8Array): Promise<void> {
  await exec
    .update(signInFailures)
    .set({ failedAttempts: sql`greatest(${signInFailures.failedAttempts} - 1, 0)` })
    .where(eq(signInFailures.subjectHash, subjectHash));
}

/** What is recorded against a pool, or `null` when nothing is. Reads only. */
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

/** A success: the pool starts again with every free attempt. */
export async function clearSignInFailures(exec: Executor, subjectHash: Uint8Array): Promise<void> {
  await exec.delete(signInFailures).where(eq(signInFailures.subjectHash, subjectHash));
}

/**
 * Deletes the rows that can no longer hold anybody back: last attempt before
 * `before`, and no lockout still running at `now`. For the scheduled worker.
 * Answers how many, as a count — never the rows: a spray of made-up addresses
 * can leave a great many of them, and none is worth carrying back.
 */
export async function pruneSignInFailures(
  exec: Executor,
  params: { before: Date; now: Date },
): Promise<number> {
  const result: unknown = await exec
    .delete(signInFailures)
    .where(
      and(
        lt(signInFailures.lastFailedAt, params.before),
        or(isNull(signInFailures.lockedUntil), lt(signInFailures.lockedUntil, params.now)),
      ),
    );
  return affectedRows(result);
}

/**
 * The rows a write touched, from either driver's result: postgres.js's `count`
 * (production), PGlite's `affectedRows` (tests).
 */
function affectedRows(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const record = result as { count?: unknown; affectedRows?: unknown };
  if (typeof record.count === 'number') return record.count;
  if (typeof record.affectedRows === 'number') return record.affectedRows;
  return 0;
}
