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
 * How long a vault may sit idle before it locks, in minutes.
 *
 * ── One number, honoured on both sides ──
 * This drives the browser's idle timer *and* {@link isVaultUnlocked}, which is
 * what the route wrapper gates every request on. They were separate until the
 * unlock-convenience work: the timer read the account's preference while the
 * server counted a fixed eight hours, so a client that simply never ran its
 * timer kept a session the server still considered unlocked for the rest of the
 * day. One number cannot disagree with itself.
 *
 * ── Why there is no "never" any more ──
 * There used to be a `0`. A preference the *server* honours cannot be allowed to
 * say "this session stays unlocked forever" — that is not an idle timer, it is
 * an indefinitely replayable cookie. The loosest option is
 * {@link MAX_AUTO_LOCK_MINUTES}, half a day, and what really ends it is the tab
 * dying: the key material this convenience keeps alive lives in `sessionStorage`
 * and nowhere more durable.
 *
 * ── A menu on screen, a range in the database ──
 * The four options are a product decision and may grow. The floor and the
 * ceiling are the security decision, and {@link clampAutoLockMinutes} is what a
 * request is held to — so a hand-crafted body asking for one minute gets fifteen
 * rather than a 422, and no stored row can ever be outside the range the gate
 * assumes.
 */
export const AUTO_LOCK_MINUTES_OPTIONS = [15, 60, 240, 720] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES_OPTIONS)[number];

/**
 * The floor: tight enough to be a real posture, loose enough that choosing it is
 * not a denial of service against its own owner. Below about a quarter of an
 * hour, the server gate's resolution — `last_seen_at`, written at most once per
 * `SESSION_TOUCH_INTERVAL_MS` — would start to dominate the preference.
 */
export const MIN_AUTO_LOCK_MINUTES = 15;

/** The ceiling: half a day. What "until this browser closes" stores. */
export const MAX_AUTO_LOCK_MINUTES = 720;

/** What a row with no preference resolves to. An hour of idleness. */
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 60;

/**
 * The effective allowance for a stored preference.
 *
 * `null` — the account never chose — resolves to the default, which is why the
 * column is nullable rather than defaulted: the default may be reconsidered
 * later without rewriting anybody's row. Everything else is clamped rather than
 * refused, so this function has one failure mode (none) and every caller gets a
 * number the gate and the database CHECK both accept.
 */
export function clampAutoLockMinutes(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
  return Math.min(Math.max(Math.round(minutes), MIN_AUTO_LOCK_MINUTES), MAX_AUTO_LOCK_MINUTES);
}

/** Whether a value is one of the intervals the settings menu actually offers. */
export function isAutoLockMinutes(value: number): value is AutoLockMinutes {
  return (AUTO_LOCK_MINUTES_OPTIONS as readonly number[]).includes(value);
}

/**
 * The offered option closest to a stored value.
 *
 * The menu is a set and the column is a range, so the two can legitimately
 * disagree: a row remapped by migration 0015, or a hand-crafted PATCH of 37
 * minutes, is a perfectly valid preference that names no menu item. A picker
 * asked to display it would render blank — which reads as "auto-lock is off" on
 * the one screen where that must never be a guess. This answers with the item
 * to highlight, and the caller still saves the exact number it was given.
 */
export function nearestAutoLockOption(minutes: number | null | undefined): AutoLockMinutes {
  const effective = clampAutoLockMinutes(minutes);
  return AUTO_LOCK_MINUTES_OPTIONS.reduce((best, option) =>
    Math.abs(option - effective) < Math.abs(best - effective) ? option : best,
  );
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
 * The ceiling on one unlock, whatever the preference says.
 *
 * A working day. The idle allowance below can slide indefinitely — a session
 * that makes a request every ten minutes never goes idle — so without an
 * absolute limit a stolen cookie replayed on a timer would stay unlocked
 * forever. This is the line that says a passphrase is typed at least once a day,
 * and it is why the loosest preference is described as "until this browser
 * closes" rather than as twelve hours: for anyone who picks that, this is what
 * ends the unlock if the tab outlives the day.
 */
export const VAULT_UNLOCK_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * How many wrong device PINs a browser gets before its enrolment is destroyed.
 *
 * ── Why this is the whole budget, and why it is spent rather than paused ──
 * A six-digit PIN is 10^6 candidates. Everything that makes it safe to wrap a
 * User Key under one is on this line: the wrap cannot be attacked without the
 * server's pepper, and the pepper is released only by a correct verifier, so the
 * attacker's guesses are *online* and countable. Five is what an honest owner
 * needs and four more than a guesser deserves.
 *
 * At five the pepper row is **deleted**, not locked out. There is nothing to
 * come back to: the pepper is gone, so the wrap in that browser cannot be opened
 * by anybody who never saw the pepper it was built under — the correct PIN
 * included — and the passphrase is the only way in. A timed lockout would imply
 * the PIN becomes usable again, and "wait an hour and keep guessing" is not a
 * budget for a credential whose entire budget is this counter.
 *
 * Deliberately unlike {@link VAULT_FREE_ATTEMPTS}, whose escalating backoff suits
 * a master passphrase: an attacker there is up against real entropy and the
 * lockout only has to make guessing slow. Here it has to make guessing *end*.
 */
export const DEVICE_PIN_MAX_ATTEMPTS = 5;

/** What one more wrong PIN costs the enrolment that took it. */
export interface DevicePinFailure {
  /** The counter to store. Meaningless when `burned` — the row is deleted. */
  attempts: number;
  /** Whether this failure spent the last attempt. */
  burned: boolean;
  /** What the screen may say. `0` once burned. */
  attemptsRemaining: number;
}

/**
 * The state after one more wrong PIN.
 *
 * Pure, and separated from the repository for the same reason the unlock backoff
 * is: "how many tries are left" is a number the settings copy, the lock screen
 * and the database CHECK all restate, and three restatements of a rule that
 * lives nowhere is how they come to disagree.
 */
export function nextPinFailure(attempts: number): DevicePinFailure {
  const next = Math.max(0, Math.trunc(attempts)) + 1;

  if (next >= DEVICE_PIN_MAX_ATTEMPTS) {
    return { attempts: DEVICE_PIN_MAX_ATTEMPTS, burned: true, attemptsRemaining: 0 };
  }

  return { attempts: next, burned: false, attemptsRemaining: DEVICE_PIN_MAX_ATTEMPTS - next };
}

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
 * Everything the gate needs about one session's unlock.
 *
 * A record rather than three positional arguments, because two of the three are
 * `Date`s and a call site that swapped them would compile, run, and be wrong in
 * the direction that keeps a vault unlocked.
 */
export interface VaultUnlockState {
  /** `null` — never unlocked — is the state every session is created in. */
  vaultUnlockedAt: Date | null;
  /**
   * The last request this session made: the server's only view of activity.
   *
   * Written at most once per `SESSION_TOUCH_INTERVAL_MS`, so it lags real
   * activity by up to five minutes. That granularity is why
   * {@link MIN_AUTO_LOCK_MINUTES} is fifteen and not two.
   */
  lastSeenAt: Date;
  /** The account's preference in minutes; `null` means no preference. */
  autoLockMinutes: number | null;
}

/**
 * Whether a session is currently unlocked.
 *
 * ── Two limits, and why neither alone is enough ──
 * The **idle allowance** is the account's own preference, measured from the
 * later of the unlock and the last request. Measuring from the unlock alone
 * would be an *absolute* timer wearing an idle timer's name: somebody who picked
 * fifteen minutes and then worked steadily for an hour would be thrown back to
 * the lock screen four times, while their browser's idle timer — which activity
 * resets — never fired once. The two halves of the lock have to mean the same
 * thing, which is the whole reason the preference is read here at all.
 *
 * The **ceiling**, {@link VAULT_UNLOCK_MAX_MS}, is measured from the unlock and
 * never slides. Without it, a sliding window is a window that never closes: a
 * stolen cookie replayed once an hour would hold an unlocked session for as long
 * as the attacker cared to keep replaying it.
 *
 * `null` for `vaultUnlockedAt` means it has never been unlocked — the state a
 * session is in the moment it is created, so a fresh sign-in still passes
 * through the unlock screen and the cookie alone is never enough to reach key
 * material.
 */
export function isVaultUnlocked(state: VaultUnlockState, now: Date): boolean {
  if (state.vaultUnlockedAt === null) return false;
  if (now.getTime() - state.vaultUnlockedAt.getTime() >= VAULT_UNLOCK_MAX_MS) return false;
  return now.getTime() < vaultUnlockExpiryFrom(state).getTime();
}

/**
 * When the current unlock lapses, for the client to schedule a re-lock against.
 *
 * The *idle* expiry, not the ceiling: it is what the client's own timer is
 * counting down to, and reporting the ceiling would have the dashboard promise
 * hours it is not going to give. `isVaultUnlocked` applies both.
 */
export function vaultUnlockExpiryFrom(state: VaultUnlockState): Date {
  const anchor = Math.max(state.vaultUnlockedAt?.getTime() ?? 0, state.lastSeenAt.getTime());
  return new Date(anchor + clampAutoLockMinutes(state.autoLockMinutes) * 60_000);
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
