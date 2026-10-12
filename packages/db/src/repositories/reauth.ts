import { and, eq, gt, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { reauthentications } from '../schema/reauth';
import type { Executor } from './shared';

/**
 * Re-authentication for the vault reset: the server's record of how far one
 * person has got through the two locks in front of it. Migration 0019 has the
 * argument; this module has the writes, and each write re-asserts every fact
 * the step before it established rather than trusting the caller to have read
 * them a moment earlier.
 *
 * The steps, each bound to `(session, user)`:
 *
 *  1. {@link recordFreshSignIn} — the fresh sign-in completed and issued this
 *     session. Written by the sign-in callback, in the same transaction as the
 *     session row.
 *  2. {@link markReauthCodeSent} — WorkOS was asked to email a code.
 *  3. {@link reserveReauthGuess} — one guess (the emailed code, or the
 *     authenticator code WorkOS may ask for after it) is reserved against the
 *     attempt's and the user's budgets **before** WorkOS is asked to check it.
 *  4. {@link issueReauthProof} — the guess was right; a proof is minted and its
 *     hash stored.
 *  5. {@link consumeReauthProof} — the reset spends it, once, before it expires.
 *
 * Nothing here accepts a raw proof or a raw pending-authentication token. The
 * caller hashes on the way in, the rule `sessions.ts` keeps for session tokens.
 */

export type Reauthentication = typeof reauthentications.$inferSelect;

/** Step 1: the fresh sign-in that issued `sessionId` completed at `at`. */
export async function recordFreshSignIn(
  exec: Executor,
  params: { userId: string; sessionId: string; at: Date },
): Promise<void> {
  await exec.insert(reauthentications).values({
    id: uuidv7(),
    userId: params.userId,
    sessionId: params.sessionId,
    signedInAt: params.at,
  });
}

/**
 * This session's re-authentication, if its fresh sign-in happened at or after
 * `signedInSince`, nothing has spent it, and it has guesses left.
 *
 * Keyed on the session *and* the user. The session alone would do today —
 * `session_id` is unique and a session has one owner — but a lookup that also
 * names the person is one whose answer cannot be about somebody else if either
 * of those ever stops being true.
 */
export async function findFreshSignIn(
  exec: Executor,
  params: { userId: string; sessionId: string; signedInSince: Date; maxAttempts: number },
): Promise<Reauthentication | null> {
  const [row] = await exec
    .select()
    .from(reauthentications)
    .where(
      and(
        eq(reauthentications.sessionId, params.sessionId),
        eq(reauthentications.userId, params.userId),
        gte(reauthentications.signedInAt, params.signedInSince),
        isNull(reauthentications.usedAt),
        // An attempt that has used its guesses is over: the person signs in
        // again, which starts a new one (still under the per-user budget).
        lt(reauthentications.codeAttempts, params.maxAttempts),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Step 2, bookkeeping: a code was requested for this attempt. */
export async function markReauthCodeSent(exec: Executor, id: string, at: Date): Promise<void> {
  await exec
    .update(reauthentications)
    .set({ codeSentAt: at })
    .where(and(eq(reauthentications.id, id), isNull(reauthentications.usedAt)));
}

export type GuessReservation =
  | { ok: true; attempt: Pick<Reauthentication, 'id' | 'mfaPendingHash' | 'mfaFactorId'> }
  /**
   * No live attempt to guess against: none, too old, already spent, its code
   * never requested, or its own guesses used up. The answer is "sign in again".
   */
  | { ok: false; reason: 'no-attempt' }
  /** The account has used its guesses for the day, across every attempt. */
  | { ok: false; reason: 'user-budget' };

/**
 * Step 3: reserves one guess, atomically, before anybody asks WorkOS whether it
 * is right.
 *
 * ── Why before, and why both budgets here ──
 * Counting a guess *after* WorkOS answered left three ways round the cap: a
 * burst of concurrent guesses all reached WorkOS before any of them was
 * counted; an answer the caller did not classify as "wrong" cost nothing; and
 * the count lived on the attempt, so signing in again bought a fresh five. So:
 *
 *  - The per-attempt cap is in the UPDATE's own predicate — `code_attempts <
 *    max` — so of N concurrent guesses at most the remaining allowance get a
 *    row back, whatever WorkOS later says to any of them.
 *  - The per-user cap counts every attempt this account started in the window.
 *    A sum across rows cannot be made atomic by one row's predicate, so the
 *    user's own row is locked first: guesses from two sessions of one account
 *    queue on it, and each sees the other's reservation.
 *  - A guess is only taken on an attempt whose code was actually requested —
 *    there is nothing to guess before that, and refusing it keeps a guess
 *    burst from preceding the request it would be waiting for.
 *
 * The lock is held only for this short transaction, never across the call to
 * WorkOS.
 */
export async function reserveReauthGuess(
  exec: Executor,
  params: {
    userId: string;
    sessionId: string;
    signedInSince: Date;
    maxAttempts: number;
    maxUserAttempts: number;
    userWindowSince: Date;
  },
): Promise<GuessReservation> {
  return exec.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1)
      .for('update');

    const [used] = await tx
      .select({ total: sql<number>`coalesce(sum(${reauthentications.codeAttempts}), 0)::int` })
      .from(reauthentications)
      .where(
        and(
          eq(reauthentications.userId, params.userId),
          gte(reauthentications.signedInAt, params.userWindowSince),
        ),
      );
    if ((used?.total ?? 0) >= params.maxUserAttempts) return { ok: false, reason: 'user-budget' };

    const [reserved] = await tx
      .update(reauthentications)
      .set({ codeAttempts: sql`${reauthentications.codeAttempts} + 1` })
      .where(
        and(
          eq(reauthentications.sessionId, params.sessionId),
          eq(reauthentications.userId, params.userId),
          gte(reauthentications.signedInAt, params.signedInSince),
          isNull(reauthentications.usedAt),
          isNotNull(reauthentications.codeSentAt),
          lt(reauthentications.codeAttempts, params.maxAttempts),
        ),
      )
      .returning({
        id: reauthentications.id,
        mfaPendingHash: reauthentications.mfaPendingHash,
        mfaFactorId: reauthentications.mfaFactorId,
      });
    return reserved ? { ok: true, attempt: reserved } : { ok: false, reason: 'no-attempt' };
  });
}

/**
 * The emailed code was right, and WorkOS wants the user's authenticator too:
 * records which factor to challenge and the hash of the pending-authentication
 * token the browser was handed, so that the authenticator step can only finish
 * *this* attempt.
 */
export async function recordReauthMfaPending(
  exec: Executor,
  params: { id: string; pendingHash: Uint8Array; factorId: string },
): Promise<boolean> {
  const rows = await exec
    .update(reauthentications)
    .set({ mfaPendingHash: params.pendingHash, mfaFactorId: params.factorId })
    .where(and(eq(reauthentications.id, params.id), isNull(reauthentications.usedAt)))
    .returning({ id: reauthentications.id });
  return rows.length > 0;
}

/**
 * Step 4: records a minted proof against this session's fresh sign-in.
 *
 * The UPDATE re-asserts what the caller decided on — same session, same user,
 * sign-in still inside the window, its code requested, not yet spent — so an
 * attempt that aged out or was spent between the read and the write mints
 * nothing. The guess that earned the proof was already reserved, so there is
 * no budget to re-check here. A second success replaces the first proof rather
 * than adding one, and clears any pending authenticator step.
 *
 * Returns whether a proof was recorded. `false` means the caller must not hand
 * the proof out.
 */
export async function issueReauthProof(
  exec: Executor,
  params: {
    userId: string;
    sessionId: string;
    signedInSince: Date;
    proofHash: Uint8Array;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await exec
    .update(reauthentications)
    .set({
      proofHash: params.proofHash,
      proofExpiresAt: params.expiresAt,
      mfaPendingHash: null,
      mfaFactorId: null,
    })
    .where(
      and(
        eq(reauthentications.sessionId, params.sessionId),
        eq(reauthentications.userId, params.userId),
        gte(reauthentications.signedInAt, params.signedInSince),
        isNull(reauthentications.usedAt),
        isNotNull(reauthentications.codeSentAt),
      ),
    )
    .returning({ id: reauthentications.id });
  return rows.length > 0;
}

/**
 * Step 5: spends a proof — atomically, once.
 *
 * One UPDATE carries every condition: this exact proof, this user, this
 * session, unspent, unexpired. Two concurrent resets presenting the same proof
 * race on `used_at IS NULL`, and only one of them gets a row back; the other is
 * refused exactly as an expired proof would be. There is no read before it to
 * go stale.
 */
export async function consumeReauthProof(
  exec: Executor,
  params: { userId: string; sessionId: string; proofHash: Uint8Array; now: Date },
): Promise<boolean> {
  const rows = await exec
    .update(reauthentications)
    .set({ usedAt: params.now })
    .where(
      and(
        eq(reauthentications.proofHash, params.proofHash),
        eq(reauthentications.userId, params.userId),
        eq(reauthentications.sessionId, params.sessionId),
        isNull(reauthentications.usedAt),
        gt(reauthentications.proofExpiresAt, params.now),
      ),
    )
    .returning({ id: reauthentications.id });
  return rows.length > 0;
}
