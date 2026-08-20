import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { hashToken, pinResetExpiryFrom } from '@xecret/core/auth';
import type { PinAttemptState } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { pinResetTokens, userPins } from '../schema/identity';
import type { Executor } from './shared';

/**
 * Unlock PINs and the links that reset them.
 *
 * The policy — what counts as a weak PIN, how long a lockout lasts, when an
 * unlock lapses — lives in `@xecret/core/auth`. This module only stores, for the
 * same reason `sessions.ts` only stores: the rules are then unit-testable
 * without a database and exist in exactly one place.
 *
 * Two properties this file is responsible for:
 *
 *  - **A raw PIN never enters or leaves.** Callers derive the stored form and
 *    pass a string; nothing here hashes, compares, or logs. A value that never
 *    reaches this module cannot be written by it.
 *  - **The attempt counter is durable.** It is a column, not a cache. A counter
 *    that lives in a Worker isolate is a counter an attacker resets by waiting
 *    for the isolate to be recycled, which for six digits is the whole defence.
 */

export interface PinRecord extends PinAttemptState {
  userId: string;
  /** `pbkdf2-sha256$<iterations>$<salt>$<hash>`. Opaque to this module. */
  pinHash: string;
  /** Minutes of dashboard idleness before the client locks itself; `0` never. */
  autoLockMinutes: number;
  updatedAt: Date;
}

const PIN_COLUMNS = {
  userId: userPins.userId,
  pinHash: userPins.pinHash,
  failedAttempts: userPins.failedAttempts,
  lockedUntil: userPins.lockedUntil,
  autoLockMinutes: userPins.autoLockMinutes,
  updatedAt: userPins.updatedAt,
} as const;

/** `null` means this account has not set a PIN — the signal for the setup screen. */
export async function findPinForUser(exec: Executor, userId: string): Promise<PinRecord | null> {
  const [row] = await exec
    .select(PIN_COLUMNS)
    .from(userPins)
    .where(eq(userPins.userId, userId))
    .limit(1);

  return row ?? null;
}

export async function hasPin(exec: Executor, userId: string): Promise<boolean> {
  return (await findPinForUser(exec, userId)) !== null;
}

/**
 * Changes how long the dashboard may sit idle before locking itself.
 *
 * The value is validated by the caller against `AUTO_LOCK_MINUTES_OPTIONS` and
 * again by the table's CHECK; this module only stores, as ever. No row means
 * no PIN — there is nothing an idle timer could ask for — so the update
 * refusing to invent one is the correct answer, not an error to paper over.
 */
export async function setAutoLockMinutes(
  exec: Executor,
  userId: string,
  minutes: number,
): Promise<PinRecord | null> {
  const [row] = await exec
    .update(userPins)
    .set({ autoLockMinutes: minutes, updatedAt: sql`now()` })
    .where(eq(userPins.userId, userId))
    .returning(PIN_COLUMNS);

  return row ?? null;
}

/**
 * Sets or replaces a user's PIN, and clears any lockout with it.
 *
 * Resetting the counter is deliberate and safe: reaching this point requires
 * either the current PIN or a link sent to the account's own mailbox, so an
 * attacker who could clear a lockout this way already has what the lockout was
 * protecting.
 */
export async function upsertPin(exec: Executor, userId: string, pinHash: string): Promise<void> {
  const now = new Date();

  await exec
    .insert(userPins)
    .values({
      userId,
      pinHash,
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPins.userId,
      set: { pinHash, failedAttempts: 0, lockedUntil: null, updatedAt: now },
    });
}

/**
 * Records the outcome of one attempt.
 *
 * The caller computes the next state with `nextPinFailure` or
 * `clearedPinFailures` and hands it over, so the escalation curve is decided by
 * a pure function and this is a plain write. Doing the arithmetic in SQL would
 * put the policy in two places and make it untestable in one of them.
 */
export async function recordPinAttempt(
  exec: Executor,
  userId: string,
  state: PinAttemptState,
): Promise<void> {
  await exec
    .update(userPins)
    .set({
      failedAttempts: state.failedAttempts,
      lockedUntil: state.lockedUntil,
      updatedAt: new Date(),
    })
    .where(eq(userPins.userId, userId));
}

/** Replaces the stored hash after a successful unlock raised the iteration count. */
export async function rehashPin(exec: Executor, userId: string, pinHash: string): Promise<void> {
  await exec
    .update(userPins)
    .set({ pinHash, updatedAt: new Date() })
    .where(eq(userPins.userId, userId));
}

/** Removes the PIN entirely. The account is then back at the setup screen. */
export async function deletePin(exec: Executor, userId: string): Promise<void> {
  await exec.delete(userPins).where(eq(userPins.userId, userId));
}

export interface CreatePinResetParams {
  userId: string;
  /** The raw token. Hashed here; only the hash is written. */
  token: string;
  ipAddress: string | null;
}

export interface PinResetRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Issues a reset link, invalidating any the user already had.
 *
 * Superseding is the point: two live links means a stale one from an old mail —
 * possibly forwarded, possibly in a mailbox the user no longer controls — stays
 * usable. One request, one link, and the previous one dies with it.
 *
 * Both statements run in a transaction, so a failure cannot leave the account
 * with its old link consumed and no new one issued.
 */
export async function createPinReset(
  exec: Executor,
  params: CreatePinResetParams,
): Promise<PinResetRecord> {
  const now = new Date();
  const record: PinResetRecord = {
    id: uuidv7(),
    userId: params.userId,
    expiresAt: pinResetExpiryFrom(now),
  };
  const tokenHash = await hashToken(params.token);

  await exec.transaction(async (tx) => {
    await tx
      .update(pinResetTokens)
      .set({ consumedAt: now })
      .where(and(eq(pinResetTokens.userId, params.userId), isNull(pinResetTokens.consumedAt)));

    await tx.insert(pinResetTokens).values({
      id: record.id,
      userId: record.userId,
      tokenHash,
      expiresAt: record.expiresAt,
      requestedIp: params.ipAddress,
      createdAt: now,
    });
  });

  return record;
}

/**
 * Consumes a reset link, returning the user it belongs to.
 *
 * One statement, and the `WHERE` clause is the security boundary: it matches
 * only a row that is unconsumed and unexpired, and the `UPDATE` marks it
 * consumed in the same breath. Two callers presenting the same link race on the
 * row, and exactly one gets a result — a check-then-write would let both pass.
 *
 * Returns `null` for unknown, expired and already-used alike. The caller gives
 * one answer for all three, because distinguishing them tells a stranger holding
 * a guessed token which part of their guess was right.
 *
 * The expiry comparison is Drizzle's `gt` and not a `sql` template, which is
 * load-bearing rather than a matter of style. An operator binds its value
 * through the column, so the `Date` is encoded as the column's type demands. A
 * `Date` interpolated into a `sql` template has no column to encode it and
 * arrives at postgres.js as a `Date` — which the driver would ordinarily
 * serialise itself, except that Drizzle replaces those serialisers with the
 * identity function in order to do its own date mapping. Nothing is left to
 * convert it, the raw object reaches the wire protocol, and the query dies with
 * a `TypeError`. It did exactly that here: every PIN reset returned a 500 until
 * this line stopped being a template. The same applies anywhere a `Date` would
 * be interpolated into `sql` — pass it through an operator, or format it
 * explicitly as `audit.ts` does.
 */
export async function consumePinReset(
  exec: Executor,
  tokenHash: Uint8Array,
  now = new Date(),
): Promise<{ userId: string } | null> {
  const [row] = await exec
    .update(pinResetTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(pinResetTokens.tokenHash, tokenHash),
        isNull(pinResetTokens.consumedAt),
        gt(pinResetTokens.expiresAt, now),
      ),
    )
    .returning({ userId: pinResetTokens.userId });

  return row ?? null;
}

/**
 * Deletes reset rows that expired before `before`. For a scheduled worker.
 *
 * Consumed rows are deleted on the same schedule rather than immediately: for
 * the short window they survive, they are what answers "was this reset used, and
 * when?" during an incident.
 */
export async function deleteExpiredPinResets(exec: Executor, before: Date): Promise<number> {
  const result = await exec.delete(pinResetTokens).where(lt(pinResetTokens.expiresAt, before));
  return result.count;
}
