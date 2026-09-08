import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/encoding';
import {
  AUTO_LOCK_MINUTES_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  UNLOCK_VERIFIER_BYTES,
  VAULT_FREE_ATTEMPTS,
  VAULT_LOCKOUT_BASE_MS,
  VAULT_LOCKOUT_MAX_MS,
  VAULT_UNLOCK_MS,
  clearedUnlockFailures,
  evaluateUnlockLockout,
  hashUnlockVerifier,
  isAutoLockMinutes,
  isVaultUnlocked,
  nextUnlockFailure,
  unlockVerifierMatches,
  vaultUnlockExpiryFrom,
} from './vault';
import type { UnlockAttemptState } from './vault';

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
  it('treats a session that has never been unlocked as locked', () => {
    // A fresh sign-in lands here, which is what makes the cookie insufficient on
    // its own to reach key material.
    expect(isVaultUnlocked(null, NOW)).toBe(false);
  });

  it('stays unlocked for the working day, then re-locks', () => {
    expect(isVaultUnlocked(new Date(NOW.getTime() - VAULT_UNLOCK_MS + 1000), NOW)).toBe(true);
    expect(isVaultUnlocked(new Date(NOW.getTime() - VAULT_UNLOCK_MS), NOW)).toBe(false);
  });

  it('is not extended by activity', () => {
    // Deliberate: the window is measured from the unlock, so a laptop left open
    // with a background tab polling cannot hold itself unlocked indefinitely.
    expect(isVaultUnlocked(new Date(NOW.getTime() - VAULT_UNLOCK_MS - 1), NOW)).toBe(false);
  });

  it('reports the expiry the client schedules its re-lock against', () => {
    expect(vaultUnlockExpiryFrom(NOW).getTime()).toBe(NOW.getTime() + VAULT_UNLOCK_MS);
    expect(isVaultUnlocked(NOW, new Date(vaultUnlockExpiryFrom(NOW).getTime() - 1))).toBe(true);
    expect(isVaultUnlocked(NOW, vaultUnlockExpiryFrom(NOW))).toBe(false);
  });
});

describe('the auto-lock menu', () => {
  it('offers a fixed set, with a default drawn from it', () => {
    expect(AUTO_LOCK_MINUTES_OPTIONS).toContain(DEFAULT_AUTO_LOCK_MINUTES);
    for (const minutes of AUTO_LOCK_MINUTES_OPTIONS) {
      expect(isAutoLockMinutes(minutes)).toBe(true);
    }
  });

  it('refuses an interval no settings screen can display or repair', () => {
    for (const minutes of [-1, 1, 43, 61, 1440, 0.5, Number.NaN]) {
      expect(isAutoLockMinutes(minutes)).toBe(false);
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
