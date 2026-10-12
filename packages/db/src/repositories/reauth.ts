import { and, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { reauthentications } from '../schema/reauth';
import type { Executor } from './shared';

/**
 * Re-authentication for the vault reset: the server's record of how far one
 * person has got through the two locks in front of it. Migration 0019 has the
 * argument; this module has the writes, and each write re-asserts every fact
 * the step before it established rather than trusting the caller to have read
 * them a moment earlier.
 *
 * The three steps, each bound to `(session, user)`:
 *
 *  1. {@link recordFreshSignIn} — the forced sign-in completed and issued this
 *     session. Written by the sign-in callback.
 *  2. {@link issueReauthProof} — the emailed code verified while the sign-in was
 *     still fresh; a proof is minted and its hash stored.
 *  3. {@link consumeReauthProof} — the reset spends it, once, before it expires.
 *
 * Nothing here accepts a raw proof. The caller hashes on the way in, the same
 * rule `sessions.ts` keeps for session tokens.
 */

export type Reauthentication = typeof reauthentications.$inferSelect;

/** Step 1: the forced sign-in that issued `sessionId` completed at `at`. */
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
 * `signedInSince` and nothing has spent it yet.
 *
 * Keyed on the session *and* the user. The session alone would do today —
 * `session_id` is unique and a session has one owner — but a lookup that also
 * names the person is one whose answer cannot be about somebody else if either
 * of those ever stops being true.
 */
export async function findFreshSignIn(
  exec: Executor,
  params: { userId: string; sessionId: string; signedInSince: Date; maxCodeFailures: number },
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
        // An attempt that has burned its wrong-code allowance is over: the
        // person signs in again, which starts a new one.
        lt(reauthentications.codeFailures, params.maxCodeFailures),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Counts one wrong code against this attempt.
 *
 * Awaited by the caller before it answers, for the reason every failure counter
 * in this codebase is: a failure recorded after the response is one a client
 * can avoid paying for by hanging up.
 */
export async function recordReauthCodeFailure(exec: Executor, id: string): Promise<void> {
  await exec
    .update(reauthentications)
    .set({ codeFailures: sql`${reauthentications.codeFailures} + 1` })
    .where(eq(reauthentications.id, id));
}

/** Bookkeeping: a code was requested for this attempt. */
export async function markReauthCodeSent(exec: Executor, id: string, at: Date): Promise<void> {
  await exec
    .update(reauthentications)
    .set({ codeSentAt: at })
    .where(and(eq(reauthentications.id, id), isNull(reauthentications.usedAt)));
}

/**
 * Step 2: records a minted proof against this session's fresh sign-in.
 *
 * The UPDATE re-asserts what the caller decided on — same session, same user,
 * sign-in still inside the window, not yet spent, wrong-code allowance not yet
 * burned — so an attempt that aged out or ran out between the read and the
 * write mints nothing. A second successful
 * verification replaces the first proof rather than adding one: an attempt has
 * at most one live proof, and the older one stops working the moment the newer
 * one exists.
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
    maxCodeFailures: number;
    proofHash: Uint8Array;
    expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await exec
    .update(reauthentications)
    .set({ proofHash: params.proofHash, proofExpiresAt: params.expiresAt })
    .where(
      and(
        eq(reauthentications.sessionId, params.sessionId),
        eq(reauthentications.userId, params.userId),
        gte(reauthentications.signedInAt, params.signedInSince),
        isNull(reauthentications.usedAt),
        lt(reauthentications.codeFailures, params.maxCodeFailures),
      ),
    )
    .returning({ id: reauthentications.id });
  return rows.length > 0;
}

/**
 * Step 3: spends a proof — atomically, once.
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
