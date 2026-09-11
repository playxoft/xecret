import { describe, expect, it } from 'vitest';

import {
  DEVICE_PIN_WRAP_KEY,
  hasDevicePinWrap,
  readNudgeDismissedAt,
  rememberNudge,
  shouldNudge,
  UNLOCK_NUDGE_INTERVAL_MS,
  UNLOCK_NUDGE_KEY,
} from './unlock-nudge';
import type { NudgeStorage, UnlockNudgeInput } from './unlock-nudge';

/**
 * When the product may suggest a faster unlock, and — mostly — when it may not.
 *
 * Every rule here is a way of not being a pest, and a pest is what the feature
 * degrades into the moment one of them is dropped: the same suggestion, after
 * every unlock, to somebody who has already taken it.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 11, 9, 0, 0);

/** Somebody who has just typed a passphrase and has nothing better to hand. */
const eligible: UnlockNudgeInput = {
  cause: 'passphrase',
  hasPasskey: false,
  hasPinWrap: false,
  dismissedAt: null,
  now: NOW,
};

describe('offering a faster unlock', () => {
  it('offers it after a passphrase unlock with nothing else enrolled', () => {
    expect(shouldNudge(eligible)).toBe(true);
  });

  it('says nothing to somebody who already has a passkey', () => {
    expect(shouldNudge({ ...eligible, hasPasskey: true })).toBe(false);
  });

  it('says nothing to a browser that already holds a PIN wrap', () => {
    // Advertising a one-touch unlock to somebody who already has one is
    // nagging about a problem they have solved.
    expect(shouldNudge({ ...eligible, hasPinWrap: true })).toBe(false);
  });
});

describe('what counts as an unlock worth nudging after', () => {
  it('never nudges after a passkey unlock, which is the thing being offered', () => {
    expect(shouldNudge({ ...eligible, cause: 'passkey' })).toBe(false);
  });

  it('never nudges after a restore, which asked the person for nothing', () => {
    // A reloaded tab finds its own keys in the session mirror. Treating that as
    // an unlock would put the message on screen at every refresh.
    expect(shouldNudge({ ...eligible, cause: 'restored' })).toBe(false);
  });
});

describe('the dismissal', () => {
  it('stays quiet 29 days after being waved away', () => {
    expect(shouldNudge({ ...eligible, dismissedAt: NOW - 29 * DAY })).toBe(false);
  });

  it('asks again after 31', () => {
    // Not forever: the answer to "not now" changes when the laptop does.
    expect(shouldNudge({ ...eligible, dismissedAt: NOW - 31 * DAY })).toBe(true);
  });

  it('lasts exactly thirty days, to the millisecond', () => {
    const boundary = NOW - UNLOCK_NUDGE_INTERVAL_MS;
    expect(shouldNudge({ ...eligible, dismissedAt: boundary })).toBe(true);
    expect(shouldNudge({ ...eligible, dismissedAt: boundary + 1 })).toBe(false);
  });

  it('stays quiet when the clock has moved backwards', () => {
    // A timezone fix or a corrected system time. Deferring one nudge is the
    // cheaper of the two ways to be wrong.
    expect(shouldNudge({ ...eligible, dismissedAt: NOW + DAY })).toBe(false);
  });
});

describe('remembering it across reloads', () => {
  function storage(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial));
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    } satisfies NudgeStorage & { items: Map<string, string> };
  }

  it('round-trips the moment the offer was made', () => {
    const store = storage();
    rememberNudge(store, NOW);
    expect(store.items.get(UNLOCK_NUDGE_KEY)).toBe(String(NOW));
    expect(readNudgeDismissedAt(store)).toBe(NOW);
  });

  it('treats a browser with no storage as one that has never been asked', () => {
    // Private mode, a blocked origin, or the server. All three mean the same
    // thing to the rule above, and none of them may throw.
    expect(readNudgeDismissedAt(null)).toBeNull();
    expect(hasDevicePinWrap(null)).toBe(false);
    expect(() => rememberNudge(null, NOW)).not.toThrow();
  });

  it('reads a corrupted timestamp as "never", rather than as "forever"', () => {
    // Erring towards one more offer, not towards silencing the feature for good
    // on the strength of a value nothing wrote.
    expect(readNudgeDismissedAt(storage({ [UNLOCK_NUDGE_KEY]: 'yesterday' }))).toBeNull();
  });

  it('finds a PIN wrap under the one name that may hold it', () => {
    expect(hasDevicePinWrap(storage())).toBe(false);
    expect(hasDevicePinWrap(storage({ [DEVICE_PIN_WRAP_KEY]: '{}' }))).toBe(true);
  });

  it('survives storage that throws on every access', () => {
    const hostile: NudgeStorage = {
      getItem() {
        throw new Error('site data is blocked');
      },
      setItem() {
        throw new Error('site data is blocked');
      },
    };

    expect(readNudgeDismissedAt(hostile)).toBeNull();
    expect(hasDevicePinWrap(hostile)).toBe(false);
    expect(() => rememberNudge(hostile, NOW)).not.toThrow();
  });
});
