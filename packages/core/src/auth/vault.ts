import { timingSafeEqual } from '../crypto/encoding';
import type { Bytes } from '../crypto/types';

/**
 * The user vault: lock policy for the zero-knowledge key hierarchy.
 *
 * ── What this module is, and what it deliberately is not ──
 * Unlocking a vault is a **client-side** question — *can I unwrap the User Key?*
 * — and its answer never leaves the browser. Nothing here decrypts anything, and
 * possessing everything this module handles opens no vault.
 *
 * What the server does hold is a `unlockVerifier`, a sibling HKDF branch of the
 * wrap key (crypto spec §8). It exists for three things and no others:
 *
 *  1. **API gating.** `sessions.vault_unlocked_at` is what `isUnlocked()` in the
 *     route wrapper reads, so a request arriving with a locked session is
 *     refused whatever the client believes. Defence in depth: the client already
 *     cannot decrypt without the passphrase, and this stops a stale tab or a
 *     replayed `fetch` from reaching a reveal endpoint at all.
 *  2. **Rate limiting.** A durable, per-account attempt counter with escalating
 *     lockout — the same control the retired PIN had, for the same reason: it is
 *     globally exact and survives an isolate being recycled.
 *  3. **Audit fidelity.** "The vault was opened at 03:00 from an unfamiliar
 *     address" is a sentence a zero-knowledge product must still be able to say.
 *
 * ── Why the backoff curve is inherited from the PIN, unchanged ──
 * The vault replaced a six-digit PIN, whose entire security budget was spent on
 * this lockout. A master passphrase is enormously stronger, so the same curve is
 * now generous relative to what it guards — which is the right direction to be
 * wrong in. Five free attempts covers ordinary fat-fingering; an hour's ceiling
 * keeps an attacker who waits out each delay to 24 tries a day while stopping
 * short of letting them lock the real owner out for a week.
 *
 * The policy is pure and separated from storage, so every escalation step is
 * testable without a database and "locked out" has one definition rather than
 * one per call site.
 */

/**
 * How long a session may sit idle before the dashboard locks itself, in
 * minutes. `0` means never. A fixed menu rather than a free number: the choice
 * is a security posture, and "43 minutes" is not a posture anyone holds — it
 * is a typo waiting to be enforced. One list feeds the settings menu, the
 * request schema, and the database CHECK, so they cannot drift.
 */
export const AUTO_LOCK_MINUTES_OPTIONS = [0, 5, 10, 20, 30, 45, 60] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES_OPTIONS)[number];

export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 10;

export function isAutoLockMinutes(value: number): value is AutoLockMinutes {
  return (AUTO_LOCK_MINUTES_OPTIONS as readonly number[]).includes(value);
}

/** Free attempts before the escalating delay starts. */
export const VAULT_FREE_ATTEMPTS = 5;

/** The first lockout, doubling with each further failure. */
export const VAULT_LOCKOUT_BASE_MS = 60 * 1000;

/**
 * The ceiling on that doubling.
 *
 * Uncapped escalation is a denial-of-service against the account's real owner:
 * an attacker who cannot guess the passphrase can still lock it out for a week.
 * An hour is long enough that guessing is hopeless and short enough that the
 * owner's own fat-fingering is not a support ticket.
 */
export const VAULT_LOCKOUT_MAX_MS = 60 * 60 * 1000;

/**
 * How long one unlock lasts.
 *
 * A working day. Long enough that nobody types a master passphrase twice in a
 * morning, short enough that a laptop left in a hotel room re-locks itself
 * overnight without anyone remembering to do anything.
 */
export const VAULT_UNLOCK_MS = 8 * 60 * 60 * 1000;

/**
 * What the database records about recent attempts against one surface.
 *
 * Two independent instances of this state exist per user — one for passphrase
 * unlock, one for recovery codes — and they are deliberately not shared. A
 * recovery code is 125 bits of uniform randomness (crypto spec §7.2), so
 * guessing one is hopeless whatever the limit; its counter is there for abuse
 * control. The passphrase counter is a real defence against a real guess.
 * Sharing them would let a mistyped recovery code spend the budget that
 * protects the passphrase, and would lock somebody out of the credential they
 * do remember because they fumbled the one they do not.
 */
export interface UnlockAttemptState {
  /** Consecutive failures since the last success. Reset to 0 on success. */
  failedAttempts: number;
  /** When the current lockout ends, or `null` when there is none. */
  lockedUntil: Date | null;
}

export interface UnlockLockout {
  locked: boolean;
  /** Milliseconds until another attempt is allowed. 0 when not locked. */
  retryAfterMs: number;
}

/** Whether an attempt may be made right now. */
export function evaluateUnlockLockout(state: UnlockAttemptState, now: Date): UnlockLockout {
  if (state.lockedUntil === null) return { locked: false, retryAfterMs: 0 };

  const remaining = state.lockedUntil.getTime() - now.getTime();
  if (remaining <= 0) return { locked: false, retryAfterMs: 0 };

  return { locked: true, retryAfterMs: remaining };
}

/**
 * The state after one more failure.
 *
 * The delay doubles from `VAULT_LOCKOUT_BASE_MS` once the free attempts are
 * spent, and stops doubling at `VAULT_LOCKOUT_MAX_MS`. `failedAttempts` keeps
 * counting past that so the escalation does not restart when a lockout expires —
 * an attacker who waits out each delay must keep waiting the maximum, rather
 * than being handed five fresh free guesses every hour.
 */
export function nextUnlockFailure(state: UnlockAttemptState, now: Date): UnlockAttemptState {
  const failedAttempts = state.failedAttempts + 1;

  if (failedAttempts <= VAULT_FREE_ATTEMPTS) {
    return { failedAttempts, lockedUntil: null };
  }

  const step = failedAttempts - VAULT_FREE_ATTEMPTS - 1;
  const delay = Math.min(VAULT_LOCKOUT_BASE_MS * 2 ** step, VAULT_LOCKOUT_MAX_MS);

  return { failedAttempts, lockedUntil: new Date(now.getTime() + delay) };
}

/** The state after a correct attempt: the slate is wiped. */
export function clearedUnlockFailures(): UnlockAttemptState {
  return { failedAttempts: 0, lockedUntil: null };
}

/**
 * Whether a session is currently unlocked.
 *
 * `null` means it has never been unlocked, which is the state a session is in
 * the moment it is created — so a fresh sign-in still passes through the unlock
 * screen, and the cookie alone is never enough to reach key material.
 */
export function isVaultUnlocked(vaultUnlockedAt: Date | null, now: Date): boolean {
  if (vaultUnlockedAt === null) return false;
  return now.getTime() - vaultUnlockedAt.getTime() < VAULT_UNLOCK_MS;
}

/** When the current unlock lapses, for the client to schedule a re-lock against. */
export function vaultUnlockExpiryFrom(vaultUnlockedAt: Date): Date {
  return new Date(vaultUnlockedAt.getTime() + VAULT_UNLOCK_MS);
}

/**
 * The length of an unlock verifier, and of its stored digest. Both 32 bytes —
 * the first is an HKDF-SHA256 output, the second a SHA-256 one.
 */
export const UNLOCK_VERIFIER_BYTES = 32;

/**
 * The stored form of an unlock verifier: a plain SHA-256.
 *
 * A fast hash is correct here, and the reasoning is the same one `tokens.ts`
 * gives for storing token hashes the same way. The input is already a 32-byte
 * Argon2id-derived HKDF output — uniformly random from the server's point of
 * view, with no structure to attack — so a memory-hard KDF over it would cost
 * the user a second and an attacker nothing.
 *
 * An attacker holding these digests gains nothing usable against the wraps
 * either: the verifier is a *sibling* HKDF branch of the wrap key rather than a
 * parent of it, and HKDF's guarantee is that one branch reveals nothing about
 * another (crypto spec §3.3, §8).
 */
export async function hashUnlockVerifier(verifier: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest('SHA-256', verifier);
  return new Uint8Array(digest);
}

/**
 * Compares a presented verifier against its stored digest, in constant time.
 *
 * `timingSafeEqual` rather than `===` on the hashes: a short-circuiting compare
 * leaks, byte by byte, how much of a guess was right — and unlike the token
 * lookup, which is an indexed query on the digest itself, this comparison is the
 * only thing standing between a guess and an unlock.
 *
 * A presented value of the wrong length is `false` rather than an error. It is a
 * fact about a string the caller already holds, the schema has already refused
 * anything malformed, and answering "no" uniformly keeps this function's failure
 * mode single.
 */
export async function unlockVerifierMatches(presented: Bytes, storedHash: Bytes): Promise<boolean> {
  if (presented.length !== UNLOCK_VERIFIER_BYTES) return false;
  return timingSafeEqual(await hashUnlockVerifier(presented), storedHash);
}
