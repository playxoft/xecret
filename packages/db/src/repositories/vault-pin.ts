import { and, desc, eq } from 'drizzle-orm';
import { nextPinFailure } from '@xecret/core/auth';
import { vaultPinPeppers } from '../schema/vault';
import type { Executor } from './shared';

/**
 * The server's half of a browser's six-digit device PIN.
 *
 * ── What is stored here, and what could never be ──
 * A 32-byte pepper and a 32-byte digest. No wrap, no salt, no PIN, and nothing
 * derived from the PIN that can be reversed — the wrap that actually holds the
 * User Key lives in one browser's `localStorage` and never reaches this server.
 * So the strongest thing a full dump of this table buys is the ability to *help*
 * somebody who already holds a specific device attack six digits, which is the
 * trade-off the settings screen states and the reason none of this is on by
 * default.
 *
 * ── Why the attempt counter is the whole of the design ──
 * The pepper is released only to a caller that presents the matching verifier,
 * and {@link attemptPinUnlock} counts every caller that does not. Five failures
 * destroy the row, and with it this server's only copy of the pepper — so the
 * wrap in that browser can no longer be opened by anybody who has not already
 * seen the pepper it was built under, and the passphrase is the only way back
 * in. That is what turns 10^6 offline guesses into five online ones, and it is
 * why the counter lives in a column rather than in a Worker isolate an attacker
 * resets by waiting.
 *
 * The qualification is not pedantry. A pepper is handed to the client on every
 * successful unlock, so "unopenable" is a claim about everybody who never
 * intercepted one — which is why {@link attemptPinUnlock} replaces it each time
 * and the client re-wraps under the new one.
 *
 * ── Why the comparison is a callback ──
 * The count and the comparison have to happen in one transaction, or two
 * concurrent requests both read `attempts = 4` and get ten guesses between them.
 * But *how* a verifier is compared is policy — constant-time, against a digest —
 * and this layer does not import the crypto. So the caller passes the comparison
 * in and this module runs it inside the row lock, the same shape
 * `resetVault`'s `requeue` and `rotateEnvDataKey`'s `assertGrantSet` take.
 */

/** One enrolment, as the settings list sees it. Never the pepper, never the digest. */
export interface PinDeviceRecord {
  deviceId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Wrong PINs since the last success. Shown as "tries left", not as a count. */
  attempts: number;
}

/** The public half of a row: everything except the pepper and the digest. */
const DEVICE_COLUMNS = {
  deviceId: vaultPinPeppers.deviceId,
  createdAt: vaultPinPeppers.createdAt,
  lastUsedAt: vaultPinPeppers.lastUsedAt,
  attempts: vaultPinPeppers.attempts,
} as const;

export interface MintPinPepperParams {
  userId: string;
  /** The browser's own uuid. Part of the primary key, with `userId`. */
  deviceId: string;
  pepper: Uint8Array;
  /** `SHA-256(HKDF(pinKey, "xecret.v2.pin-verifier"))`, 32 bytes. */
  verifierHash: Uint8Array;
}

/**
 * Enrols this browser, or re-enrols it under a new PIN.
 *
 * An upsert rather than an insert, because "change my PIN" is the same act as
 * "set my PIN" seen a second time: the browser mints no new `deviceId` — it
 * already has one — and what changes is the pepper, the digest and the counter,
 * together. Two rows for one browser would mean two live wraps of one User Key
 * on one device, only one of which any given attempt could open.
 *
 * The pepper is replaced on every re-enrolment, deliberately: the old wrap is
 * about to be overwritten in `localStorage`, and leaving its pepper live would
 * keep a wrap openable that the user believes they have just replaced.
 */
export async function mintPinPepper(
  exec: Executor,
  params: MintPinPepperParams,
): Promise<PinDeviceRecord> {
  const now = new Date();

  const [row] = await exec
    .insert(vaultPinPeppers)
    .values({
      userId: params.userId,
      deviceId: params.deviceId,
      pepper: params.pepper,
      verifierHash: params.verifierHash,
      attempts: 0,
      createdAt: now,
      lastUsedAt: null,
    })
    .onConflictDoUpdate({
      target: [vaultPinPeppers.userId, vaultPinPeppers.deviceId],
      set: {
        pepper: params.pepper,
        verifierHash: params.verifierHash,
        // Reset, not preserved. A re-enrolment is a successful act by somebody
        // who has just proved they can unlock the vault, and carrying four
        // failed guesses into it would burn a brand-new PIN on the first typo.
        attempts: 0,
        createdAt: now,
        lastUsedAt: null,
      },
    })
    .returning(DEVICE_COLUMNS);

  // Unreachable: the upsert either inserts or updates, and both return a row.
  // Thrown rather than asserted away, because a silent `undefined` here would
  // become a client holding a wrap whose pepper nothing recorded.
  if (row === undefined) {
    throw new Error('The PIN enrolment wrote no row.');
  }

  return row;
}

/**
 * The row one attempt locks, as a statement.
 *
 * Exported unexecuted so a test can read the SQL: what matters about this query
 * is that it names *both* halves of the primary key and that it takes the row
 * lock, and both are invisible from the outside once the function has run.
 */
export function pinDeviceQuery(exec: Executor, userId: string, deviceId: string) {
  return exec
    .select({
      pepper: vaultPinPeppers.pepper,
      verifierHash: vaultPinPeppers.verifierHash,
      attempts: vaultPinPeppers.attempts,
    })
    .from(vaultPinPeppers)
    .where(forDevice(userId, deviceId))
    .limit(1)
    .for('update');
}

/**
 * The settings list, as a statement.
 *
 * Exported for the same reason, and to pin the rule this directory's header
 * states: a listing never selects a credential. The pepper and the digest are
 * absent from the column list rather than dropped afterwards, so neither can
 * reach a log by accident.
 */
export function pinDevicesQuery(exec: Executor, userId: string) {
  return exec
    .select(DEVICE_COLUMNS)
    .from(vaultPinPeppers)
    .where(eq(vaultPinPeppers.userId, userId))
    .orderBy(desc(vaultPinPeppers.createdAt));
}

/** What one attempt resolved to. Every branch is a different thing to tell the user. */
export type PinAttemptOutcome =
  /**
   * The verifier matched. The pepper is released exactly once, here — and the
   * row has already been given a different one, so this is the *last* time this
   * value opens anything.
   */
  | { status: 'ok'; pepper: Uint8Array }
  /** Wrong, and the enrolment survives. */
  | { status: 'wrong'; attemptsRemaining: number }
  /** Wrong, and that was the last try — the row is gone and so is the wrap. */
  | { status: 'burned' }
  /** No enrolment for this browser: revoked elsewhere, or already burned. */
  | { status: 'unknown' };

/**
 * One PIN attempt: compare, count, and release the pepper or destroy the row.
 *
 * ── The transaction is the control, not a nicety ──
 * Read-then-write would let two concurrent attempts both see `attempts = 4`, and
 * an attacker scripting the endpoint would get as many guesses per round trip as
 * they cared to open connections. `SELECT … FOR UPDATE` serialises them onto the
 * row, so the fifth failure is the fifth failure however the requests arrive.
 *
 * ── Why a miss and a burn are separate answers ──
 * Because the browser must act differently. A burn means the local wrap is now
 * undecryptable and has to be cleared, with the user sent to the passphrase; a
 * miss means try again. Collapsing them would leave a dead wrap in
 * `localStorage` suppressing the PIN offer forever, or clear a good one on the
 * first typo.
 *
 * `unknown` is the same shape seen from the other side — the enrolment was
 * revoked from another device, or burned in another tab — and gets the same
 * treatment as a burn on the client. It is reported separately so the audit log
 * can tell "somebody guessed five times" from "somebody used a stale wrap".
 *
 * ── Why the pepper is replaced on the way out ──
 * Because otherwise it is permanent. A pepper is released to the client on every
 * successful unlock, which means it passes through a browser, a TLS session and
 * this server's memory each time — and anyone who captured one of those, *once*,
 * together with a copy of that browser's `localStorage`, could open the wrap for
 * as long as the enrolment lived. Revoking the enrolment afterwards would not
 * help: the stolen pair no longer needs this server.
 *
 * Rotating narrows that to a single unlock. The caller mints the replacement and
 * it is written inside the same row lock as the read, so the old value is dead
 * the instant it is handed over. The verifier is untouched — the same six digits
 * and the same salt still derive the same `pinKey` — so what the client has to
 * do afterwards is re-wrap the User Key it now holds, which is exactly the
 * moment it holds it.
 */
export async function attemptPinUnlock(
  exec: Executor,
  params: {
    userId: string;
    deviceId: string;
    /** Constant-time comparison against the stored digest. Runs inside the lock. */
    matches: (verifierHash: Uint8Array) => Promise<boolean>;
    /**
     * The pepper this row will hold from now on, on a match. 32 bytes.
     *
     * Passed in rather than generated here for the reason `matches` is passed
     * in: this layer stores, and does not own the CSPRNG or the length policy.
     */
    nextPepper: Uint8Array;
  },
): Promise<PinAttemptOutcome> {
  return exec.transaction(async (tx) => {
    const [row] = await pinDeviceQuery(tx, params.userId, params.deviceId);

    if (row === undefined) return { status: 'unknown' };

    if (await params.matches(row.verifierHash)) {
      await tx
        .update(vaultPinPeppers)
        // The rotation rides the write that was already happening. A separate
        // statement — or worse, a separate transaction — would leave a window in
        // which the released pepper and the stored one disagree.
        .set({ attempts: 0, lastUsedAt: new Date(), pepper: params.nextPepper })
        .where(forDevice(params.userId, params.deviceId));

      return { status: 'ok', pepper: row.pepper };
    }

    const failure = nextPinFailure(row.attempts);

    if (failure.burned) {
      // Deleted rather than locked out. There is nothing to come back to: the
      // pepper is the only thing that made the wrap openable, and a timed
      // lockout would promise a PIN that becomes usable again.
      await tx.delete(vaultPinPeppers).where(forDevice(params.userId, params.deviceId));
      return { status: 'burned' };
    }

    await tx
      .update(vaultPinPeppers)
      .set({ attempts: failure.attempts })
      .where(forDevice(params.userId, params.deviceId));

    return { status: 'wrong', attemptsRemaining: failure.attemptsRemaining };
  });
}

/**
 * Turns off the PIN for one browser. Returns whether there was one to turn off.
 *
 * Scoped by `user_id` as well as by `device_id`, so one account cannot revoke
 * another's enrolment by guessing a uuid — and an id belonging to somebody else
 * is indistinguishable here from one belonging to nobody, which is what lets the
 * caller answer the same 404 to both (threat T2).
 *
 * This can never strand an account. The passphrase wrap always exists and has no
 * removal path, so the last PIN is still not the last way in.
 *
 * What it does *not* do is reach into the browser and delete the ciphertext —
 * this server cannot. It removes the pepper, which leaves the wrap unopenable by
 * anyone who has not separately captured the pepper it was built under.
 */
export async function disablePinPepper(
  exec: Executor,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const removed = await exec
    .delete(vaultPinPeppers)
    .where(forDevice(userId, deviceId))
    .returning({ deviceId: vaultPinPeppers.deviceId });

  return removed.length > 0;
}

/** Every browser this account has enrolled, newest first. The settings list. */
export async function listPinPeppers(exec: Executor, userId: string): Promise<PinDeviceRecord[]> {
  return pinDevicesQuery(exec, userId);
}

/**
 * Destroys every PIN enrolment this account has. Returns how many died.
 *
 * Run by a passphrase change, a recovery and a vault reset, and it is not
 * optional on any of them. Each of those may leave the stored wraps addressing a
 * key hierarchy that has moved — a reset replaces the User Key outright — and a
 * pepper that outlives its wrap is a row the server will happily release to
 * whoever types the old PIN, for a wrap that opens nothing. Worse, it keeps the
 * browser offering a PIN unlock that can only ever fail.
 *
 * The wraps themselves are in browsers this server cannot reach, so it cannot
 * delete them; what it can do is drop the half of the key it holds, which leaves
 * each wrap unopenable by anyone who never saw its pepper.
 */
export async function revokeAllPinPeppers(exec: Executor, userId: string): Promise<number> {
  const removed = await exec
    .delete(vaultPinPeppers)
    .where(eq(vaultPinPeppers.userId, userId))
    .returning({ deviceId: vaultPinPeppers.deviceId });

  return removed.length;
}

/**
 * The primary key, always written as both halves.
 *
 * `device_id` alone would be a global name for a client-generated value, which
 * it is not: two accounts enrolling on the same browser are two independent
 * enrolments, and a predicate missing `user_id` is one account reaching another's
 * row.
 */
function forDevice(userId: string, deviceId: string) {
  return and(eq(vaultPinPeppers.userId, userId), eq(vaultPinPeppers.deviceId, deviceId));
}
