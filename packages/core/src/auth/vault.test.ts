import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/encoding';
import {
  AUTO_LOCK_MINUTES_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  UNLOCK_VERIFIER_BYTES,
  VAULT_FREE_ATTEMPTS,
  VAULT_LOCKOUT_BASE_MS,
  VAULT_LOCKOUT_MAX_MS,
  VAULT_UNLOCK_MAX_MS,
  clampAutoLockMinutes,
  clearedUnlockFailures,
  evaluateUnlockLockout,
  hashUnlockVerifier,
  isAutoLockMinutes,
  isVaultUnlocked,
  nearestAutoLockOption,
  nextUnlockFailure,
  unlockVerifierMatches,
  vaultUnlockExpiryFrom,
} from './vault';
import type { UnlockAttemptState, VaultUnlockState } from './vault';

const NOW = new Date('2026-09-08T12:00:00.000Z');

describe('the unlock lockout', () => {
  const state = (failedAttempts: number, lockedUntil: Date | null = null): UnlockAttemptState => ({
    failedAttempts,
    lockedUntil,
  });

  it('allows the first five attempts without delay', () => {
    let current = clearedUnlockFailures();
    for (let attempt = 1; attempt <= VAULT_FREE_ATTEMPTS; attempt += 1) {
      current = nextUnlockFailure(current, NOW);
      expect(current.failedAttempts).toBe(attempt);
      expect(current.lockedUntil).toBeNull();
      expect(evaluateUnlockLockout(current, NOW).locked).toBe(false);
    }
  });

  it('locks for a minute on the sixth, then doubles', () => {
    let current = state(VAULT_FREE_ATTEMPTS);
    const delays: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      current = nextUnlockFailure(current, NOW);
      delays.push((current.lockedUntil as Date).getTime() - NOW.getTime());
    }

    expect(delays).toEqual([
      VAULT_LOCKOUT_BASE_MS,
      VAULT_LOCKOUT_BASE_MS * 2,
      VAULT_LOCKOUT_BASE_MS * 4,
      VAULT_LOCKOUT_BASE_MS * 8,
    ]);
  });

  it('stops doubling at the maximum', () => {
    // Uncapped escalation would let an attacker who cannot guess the passphrase
    // lock the real owner out for a week.
    const current = nextUnlockFailure(state(VAULT_FREE_ATTEMPTS + 20), NOW);
    expect((current.lockedUntil as Date).getTime() - NOW.getTime()).toBe(VAULT_LOCKOUT_MAX_MS);
  });

  it('does not hand back free attempts when a lockout expires', () => {
    const afterLockout = state(9, new Date(NOW.getTime() - 1));
    expect(evaluateUnlockLockout(afterLockout, NOW).locked).toBe(false);

    const next = nextUnlockFailure(afterLockout, NOW);
    expect(next.failedAttempts).toBe(10);
    expect(next.lockedUntil).not.toBeNull();
  });

  it('reports how long is left', () => {
    const result = evaluateUnlockLockout(state(7, new Date(NOW.getTime() + 90_000)), NOW);
    expect(result).toEqual({ locked: true, retryAfterMs: 90_000 });
  });

  it('is over the instant the deadline passes', () => {
    const at = new Date(NOW.getTime() + 1000);
    expect(evaluateUnlockLockout(state(7, at), new Date(at.getTime() - 1)).locked).toBe(true);
    expect(evaluateUnlockLockout(state(7, at), at).locked).toBe(false);
  });

  it('wipes the slate on success', () => {
    expect(clearedUnlockFailures()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});

describe('the unlock window', () => {
  /** A session unlocked `agoMs` ago that has been making requests ever since. */
  const active = (agoMs: number, autoLockMinutes: number | null = null): VaultUnlockState => ({
    vaultUnlockedAt: new Date(NOW.getTime() - agoMs),
    lastSeenAt: NOW,
    autoLockMinutes,
  });

  /** A session unlocked `agoMs` ago that has made no request since. */
  const idle = (agoMs: number, autoLockMinutes: number | null = null): VaultUnlockState => ({
    vaultUnlockedAt: new Date(NOW.getTime() - agoMs),
    lastSeenAt: new Date(NOW.getTime() - agoMs),
    autoLockMinutes,
  });

  it('treats a session that has never been unlocked as locked', () => {
    // A fresh sign-in lands here, which is what makes the cookie insufficient on
    // its own to reach key material.
    expect(isVaultUnlocked({ ...idle(0), vaultUnlockedAt: null }, NOW)).toBe(false);
  });

  it('lapses once the account idles past its own preference', () => {
    const minutes = 15;
    expect(isVaultUnlocked(idle(minutes * 60_000 - 1000, minutes), NOW)).toBe(true);
    expect(isVaultUnlocked(idle(minutes * 60_000, minutes), NOW)).toBe(false);
  });

  it('follows the preference rather than one fixed window', () => {
    // The whole point of reading it here: the browser's timer and this gate are
    // the same number, so a tight setting is tight on both sides and a loose one
    // is loose on both.
    const twoHours = 2 * 60 * 60_000;
    expect(isVaultUnlocked(idle(twoHours, 15), NOW)).toBe(false);
    expect(isVaultUnlocked(idle(twoHours, 240), NOW)).toBe(true);
  });

  it('resolves no preference to the default', () => {
    expect(isVaultUnlocked(idle(DEFAULT_AUTO_LOCK_MINUTES * 60_000 - 1000, null), NOW)).toBe(true);
    expect(isVaultUnlocked(idle(DEFAULT_AUTO_LOCK_MINUTES * 60_000, null), NOW)).toBe(false);
  });

  it('clamps a stored value that is outside the range the gate assumes', () => {
    // A hand-edited row must not be able to buy an unlock longer than the
    // ceiling, or one so short the owner cannot work.
    expect(isVaultUnlocked(idle(MIN_AUTO_LOCK_MINUTES * 60_000 - 1000, 1), NOW)).toBe(true);
    expect(isVaultUnlocked(idle(MAX_AUTO_LOCK_MINUTES * 60_000 + 1000, 100_000), NOW)).toBe(false);
  });

  it('is extended by activity, because it is an idle allowance and not a stopwatch', () => {
    // Measuring from the unlock alone would throw somebody who chose fifteen
    // minutes back to the lock screen four times an hour while they were typing.
    expect(isVaultUnlocked(active(3 * 60 * 60_000, 15), NOW)).toBe(true);
  });

  it('still ends at the absolute ceiling, however busy the session is', () => {
    // Otherwise a sliding window never closes: a stolen cookie replayed on a
    // timer would hold an unlocked session for as long as anyone kept replaying.
    expect(isVaultUnlocked(active(VAULT_UNLOCK_MAX_MS - 1000, 720), NOW)).toBe(true);
    expect(isVaultUnlocked(active(VAULT_UNLOCK_MAX_MS, 720), NOW)).toBe(false);
  });

  it('reports the idle expiry the client schedules its re-lock against', () => {
    const state = idle(0, 60);
    expect(vaultUnlockExpiryFrom(state).getTime()).toBe(NOW.getTime() + 60 * 60_000);
    expect(isVaultUnlocked(state, new Date(vaultUnlockExpiryFrom(state).getTime() - 1))).toBe(true);
    expect(isVaultUnlocked(state, vaultUnlockExpiryFrom(state))).toBe(false);
  });
});

describe('the auto-lock menu', () => {
  it('offers a fixed set, with a default drawn from it', () => {
    expect(AUTO_LOCK_MINUTES_OPTIONS).toContain(DEFAULT_AUTO_LOCK_MINUTES);
    for (const minutes of AUTO_LOCK_MINUTES_OPTIONS) {
      expect(isAutoLockMinutes(minutes)).toBe(true);
    }
  });

  it('offers nothing outside the range the gate will honour', () => {
    for (const minutes of AUTO_LOCK_MINUTES_OPTIONS) {
      expect(minutes).toBeGreaterThanOrEqual(MIN_AUTO_LOCK_MINUTES);
      expect(minutes).toBeLessThanOrEqual(MAX_AUTO_LOCK_MINUTES);
    }
  });

  it('has no "never": a window the server honours cannot be infinite', () => {
    expect(isAutoLockMinutes(0)).toBe(false);
    expect(clampAutoLockMinutes(0)).toBe(MIN_AUTO_LOCK_MINUTES);
  });

  it('reports an off-menu interval as off-menu', () => {
    for (const minutes of [-1, 1, 43, 61, 1440, 0.5, Number.NaN]) {
      expect(isAutoLockMinutes(minutes)).toBe(false);
    }
  });
});

describe('clamping a stored preference', () => {
  it('resolves an absent preference to the default', () => {
    expect(clampAutoLockMinutes(null)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(undefined)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(Number.NaN)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
  });

  it('holds every answer inside the range, rather than refusing one', () => {
    // Failing towards the tighter number: a caller asking for one minute has an
    // unmistakable intention, and a 422 would leave the looser setting in place.
    expect(clampAutoLockMinutes(1)).toBe(MIN_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(-500)).toBe(MIN_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(100_000)).toBe(MAX_AUTO_LOCK_MINUTES);
    expect(clampAutoLockMinutes(37.4)).toBe(37);
  });

  it('leaves every offered option untouched', () => {
    for (const minutes of AUTO_LOCK_MINUTES_OPTIONS) {
      expect(clampAutoLockMinutes(minutes)).toBe(minutes);
    }
  });
});

describe('displaying a stored preference', () => {
  it('answers with the option a picker should highlight', () => {
    // The menu is a set and the column is a range, so a row remapped by
    // migration 0015 — or a hand-crafted PATCH — can name no menu item. A picker
    // handed that renders blank, which reads as "auto-lock is off" on the one
    // screen where that must never be a guess.
    expect(nearestAutoLockOption(null)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(nearestAutoLockOption(37)).toBe(15);
    expect(nearestAutoLockOption(45)).toBe(60);
    expect(nearestAutoLockOption(200)).toBe(240);
    expect(nearestAutoLockOption(100_000)).toBe(720);
  });

  it('answers with an option, always', () => {
    for (const minutes of [-10, 0, 1, 14, 15, 16, 300, 719, 721, 5000]) {
      expect(AUTO_LOCK_MINUTES_OPTIONS).toContain(nearestAutoLockOption(minutes));
    }
  });
});

describe('the unlock verifier', () => {
  it('accepts the verifier its digest was derived from', async () => {
    const verifier = randomBytes(UNLOCK_VERIFIER_BYTES);
    expect(await unlockVerifierMatches(verifier, await hashUnlockVerifier(verifier))).toBe(true);
  });

  it('refuses every other verifier, including one differing in a single bit', async () => {
    const verifier = randomBytes(UNLOCK_VERIFIER_BYTES);
    const stored = await hashUnlockVerifier(verifier);

    const nudged = Uint8Array.from(verifier);
    nudged[31] = (nudged[31] ?? 0) ^ 0x01;

    expect(await unlockVerifierMatches(nudged, stored)).toBe(false);
    expect(await unlockVerifierMatches(randomBytes(UNLOCK_VERIFIER_BYTES), stored)).toBe(false);
  });

  it('refuses a verifier of the wrong length rather than throwing', async () => {
    // The schema has already refused anything malformed; this keeps the
    // function's failure mode single for anything that slips past it.
    const stored = await hashUnlockVerifier(randomBytes(UNLOCK_VERIFIER_BYTES));
    for (const length of [0, 16, 31, 33, 64]) {
      expect(await unlockVerifierMatches(new Uint8Array(length), stored)).toBe(false);
    }
  });

  it('stores a 32-byte digest and never the verifier itself', async () => {
    const verifier = randomBytes(UNLOCK_VERIFIER_BYTES);
    const stored = await hashUnlockVerifier(verifier);

    expect(stored).toHaveLength(32);
    // The digest must not be the input: a column holding the verifier verbatim
    // would let a database dump replay an unlock.
    expect([...stored]).not.toEqual([...verifier]);
  });

  it('is deterministic, so a stored digest keeps verifying', async () => {
    const verifier = randomBytes(UNLOCK_VERIFIER_BYTES);
    expect([...(await hashUnlockVerifier(verifier))]).toEqual([
      ...(await hashUnlockVerifier(verifier)),
    ]);
  });
});
