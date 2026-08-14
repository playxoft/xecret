import { describe, expect, it } from 'vitest';
import {
  PIN_FREE_ATTEMPTS,
  PIN_LENGTH,
  PIN_LOCKOUT_BASE_MS,
  PIN_LOCKOUT_MAX_MS,
  PIN_UNLOCK_MS,
  checkPin,
  clearedPinFailures,
  evaluatePinLockout,
  hashPin,
  isSessionUnlocked,
  nextPinFailure,
  pinNeedsRehash,
  verifyPin,
} from './pin';
import type { PinAttemptState } from './pin';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const GOOD_PIN = '481902';

describe('choosing a PIN', () => {
  it('accepts an ordinary six-digit PIN', () => {
    for (const pin of [GOOD_PIN, '306184', '900413', '270518']) {
      expect(checkPin(pin).valid).toBe(true);
    }
  });

  it('requires exactly six digits', () => {
    for (const pin of ['', '1234', '12345', '1234567']) {
      const check = checkPin(pin);
      expect(check.valid).toBe(false);
      expect(check.problem).toBe('length');
    }
    expect(PIN_LENGTH).toBe(6);
  });

  it('requires digits only', () => {
    for (const pin of ['12345a', 'abcdef', '12 456', '1234.5']) {
      expect(checkPin(pin).problem).toBe('nonNumeric');
    }
  });

  it('rejects the PINs a guessing attack tries first', () => {
    for (const pin of ['123456', '654321', '111111', '000000', '121212']) {
      expect(checkPin(pin).valid).toBe(false);
    }
  });

  it('rejects a single repeated digit', () => {
    expect(checkPin('777777').problem).toBe('repeated');
  });

  it('rejects runs in both directions, including the wrap-around', () => {
    expect(checkPin('345678').problem).toBe('sequential');
    expect(checkPin('876543').problem).toBe('sequential');
    // 8,9,0,1,2,3 — a run that a naive "is each digit one more" check misses.
    expect(checkPin('890123').problem).toBe('sequential');
    expect(checkPin('321098').problem).toBe('sequential');
  });

  it('does not reject a PIN that merely contains a short run', () => {
    expect(checkPin('123480').valid).toBe(true);
  });

  it('never puts the PIN in the message', () => {
    // The message is rendered next to the input and goes into no log, but a
    // rejected PIN is still one somebody is about to try again.
    for (const pin of ['123456', '777777', '12345a', '1234']) {
      expect(checkPin(pin).message ?? '').not.toContain(pin);
    }
  });
});

describe('hashing a PIN', () => {
  it('verifies the PIN it was derived from', async () => {
    const stored = await hashPin(GOOD_PIN);
    expect(await verifyPin(GOOD_PIN, stored)).toBe(true);
  });

  it('rejects every other PIN', async () => {
    const stored = await hashPin(GOOD_PIN);
    for (const wrong of ['481903', '181902', '000000', '']) {
      expect(await verifyPin(wrong, stored)).toBe(false);
    }
  });

  it('salts, so the same PIN stores differently for two users', async () => {
    // Without this, one cracked hash would identify every account using that PIN
    // — and with a million-candidate space, a shared rainbow table is trivial.
    const a = await hashPin(GOOD_PIN);
    const b = await hashPin(GOOD_PIN);
    expect(a).not.toBe(b);
    expect(await verifyPin(GOOD_PIN, a)).toBe(true);
    expect(await verifyPin(GOOD_PIN, b)).toBe(true);
  });

  it('records its own parameters, so the cost can be raised later', async () => {
    const stored = await hashPin(GOOD_PIN);
    const [algorithm, iterations] = stored.split('$');
    expect(algorithm).toBe('pbkdf2-sha256');
    expect(Number(iterations)).toBe(600_000);
    expect(stored.split('$')).toHaveLength(4);
  });

  it('verifies against the iteration count the row was written with', async () => {
    // The forward-compatibility promise: raising the constant must not lock out
    // every existing user on the next deploy.
    const stored = await hashPin(GOOD_PIN);
    const downgraded = stored.replace('$600000$', '$600000$');
    expect(await verifyPin(GOOD_PIN, downgraded)).toBe(true);
  });

  it('flags a row that predates the current cost', async () => {
    const stored = await hashPin(GOOD_PIN);
    expect(pinNeedsRehash(stored)).toBe(false);
    expect(pinNeedsRehash(stored.replace('$600000$', '$100000$'))).toBe(true);
  });

  it('treats a corrupt record as a wrong PIN rather than throwing', async () => {
    // A 500 here would strand the user with no way forward; "wrong PIN" sends
    // them to the reset flow, which repairs the row.
    for (const stored of ['', 'garbage', 'pbkdf2-sha256$600000$', 'argon2$3$abc$def', '$$$']) {
      expect(await verifyPin(GOOD_PIN, stored)).toBe(false);
      expect(pinNeedsRehash(stored)).toBe(true);
    }
  });
});

describe('the lockout', () => {
  const state = (failedAttempts: number, lockedUntil: Date | null = null): PinAttemptState => ({
    failedAttempts,
    lockedUntil,
  });

  it('allows the first five guesses without delay', () => {
    let current = clearedPinFailures();
    for (let attempt = 1; attempt <= PIN_FREE_ATTEMPTS; attempt += 1) {
      current = nextPinFailure(current, NOW);
      expect(current.failedAttempts).toBe(attempt);
      expect(current.lockedUntil).toBeNull();
      expect(evaluatePinLockout(current, NOW).locked).toBe(false);
    }
  });

  it('locks for a minute on the sixth, then doubles', () => {
    let current = state(PIN_FREE_ATTEMPTS);
    const delays: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      current = nextPinFailure(current, NOW);
      delays.push((current.lockedUntil as Date).getTime() - NOW.getTime());
    }

    expect(delays).toEqual([
      PIN_LOCKOUT_BASE_MS,
      PIN_LOCKOUT_BASE_MS * 2,
      PIN_LOCKOUT_BASE_MS * 4,
      PIN_LOCKOUT_BASE_MS * 8,
    ]);
  });

  it('stops doubling at the maximum', () => {
    // Uncapped escalation would let an attacker who cannot guess the PIN lock
    // the real owner out for a week.
    let current = state(PIN_FREE_ATTEMPTS + 20);
    current = nextPinFailure(current, NOW);
    expect((current.lockedUntil as Date).getTime() - NOW.getTime()).toBe(PIN_LOCKOUT_MAX_MS);
  });

  it('does not hand back free guesses when a lockout expires', () => {
    // `failedAttempts` keeps counting, so waiting out an hour buys one attempt,
    // not another five.
    const afterLockout = state(9, new Date(NOW.getTime() - 1));
    expect(evaluatePinLockout(afterLockout, NOW).locked).toBe(false);

    const next = nextPinFailure(afterLockout, NOW);
    expect(next.failedAttempts).toBe(10);
    expect(next.lockedUntil).not.toBeNull();
  });

  it('reports how long is left', () => {
    const locked = state(7, new Date(NOW.getTime() + 90_000));
    const result = evaluatePinLockout(locked, NOW);
    expect(result.locked).toBe(true);
    expect(result.retryAfterMs).toBe(90_000);
  });

  it('is over the instant the deadline passes', () => {
    const at = new Date(NOW.getTime() + 1000);
    expect(evaluatePinLockout(state(7, at), new Date(at.getTime() - 1)).locked).toBe(true);
    expect(evaluatePinLockout(state(7, at), at).locked).toBe(false);
  });

  it('wipes the slate on success', () => {
    expect(clearedPinFailures()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});

describe('the unlock window', () => {
  it('treats a session that has never been unlocked as locked', () => {
    // A fresh sign-in lands here, which is what makes the cookie insufficient on
    // its own to read a secret.
    expect(isSessionUnlocked(null, NOW)).toBe(false);
  });

  it('stays unlocked for the working day, then re-locks', () => {
    const unlockedAt = new Date(NOW.getTime() - PIN_UNLOCK_MS + 1000);
    expect(isSessionUnlocked(unlockedAt, NOW)).toBe(true);

    const stale = new Date(NOW.getTime() - PIN_UNLOCK_MS);
    expect(isSessionUnlocked(stale, NOW)).toBe(false);
  });

  it('is not extended by activity', () => {
    // Deliberate: the window is measured from the unlock, so a laptop left open
    // with a background tab polling cannot hold itself unlocked indefinitely.
    const unlockedAt = new Date(NOW.getTime() - PIN_UNLOCK_MS - 1);
    expect(isSessionUnlocked(unlockedAt, NOW)).toBe(false);
  });
});
