import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';

import {
  clearDevicePinWrap,
  DEVICE_PIN_WRAP_KEY,
  DEVICE_PIN_WRAP_VERSION,
  enrolmentPinProblem,
  parseDevicePinWrap,
  pinProblem,
  readDevicePinWrap,
  weakPinProblem,
  writeDevicePinWrap,
} from './device-pin';
import type { DevicePinStorage, DevicePinWrap } from './device-pin';
import { hasDevicePinWrap } from './unlock-nudge';

/**
 * The record a device PIN leaves on disk, and every way it can be wrong.
 *
 * ── Why these assertions are worth having ──
 * None of them is visible on screen. A record that fails to parse costs one
 * passphrase entry; a record that *mis*parses derives a key that will not open
 * the wrap, and spends one of five attempts finding that out. The difference
 * between those two outcomes is the whole of this file.
 */

const deviceId = uuidv7();

function record(overrides: Partial<DevicePinWrap> = {}): DevicePinWrap {
  return {
    version: DEVICE_PIN_WRAP_VERSION,
    deviceId,
    salt: 'c2FsdHlzYWx0eXNhbHR5c2E',
    wrap: `xk2.gcm.${'A'.repeat(64)}`,
    ...overrides,
  };
}

/** A `localStorage` that can be inspected. The tests run without a DOM. */
function fakeStorage(): DevicePinStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe('the stored PIN wrap', () => {
  it('round-trips through storage unchanged', () => {
    const storage = fakeStorage();
    writeDevicePinWrap(storage, record());

    expect(readDevicePinWrap(storage)).toEqual(record());
  });

  it('lives under the key the nudge already probes', () => {
    // Phase 2's nudge suppresses itself when this key is present. The two must
    // agree, or somebody with a PIN would be offered a faster unlock at every
    // passphrase entry.
    const storage = fakeStorage();
    writeDevicePinWrap(storage, record());

    expect(storage.entries.has(DEVICE_PIN_WRAP_KEY)).toBe(true);
    expect(hasDevicePinWrap(storage)).toBe(true);
  });

  it('refuses a record written by a different version', () => {
    // The same rule the `xk2.` blob format keeps: a record written by a later
    // shape must fail to be read rather than be misread as this one.
    expect(parseDevicePinWrap(JSON.stringify(record({ version: 2 })))).toBeNull();
    expect(parseDevicePinWrap(JSON.stringify(record({ version: 0 })))).toBeNull();
  });

  it('refuses a record missing any field, or holding the wrong type', () => {
    for (const broken of [
      { ...record(), deviceId: undefined },
      { ...record(), deviceId: '' },
      { ...record(), salt: undefined },
      { ...record(), wrap: undefined },
      { ...record(), wrap: 42 },
      { ...record(), version: undefined },
    ]) {
      expect(parseDevicePinWrap(JSON.stringify(broken)), JSON.stringify(broken)).toBeNull();
    }
  });

  it('refuses a wrap that is not an xk2.gcm blob', () => {
    for (const wrap of ['xk1.gcm.AAAA', 'xk2.x25519.AAAA', 'AAAA', '']) {
      expect(parseDevicePinWrap(JSON.stringify(record({ wrap }))), wrap).toBeNull();
    }
  });

  it('refuses a truncated write and anything that is not JSON', () => {
    expect(parseDevicePinWrap('{"version":1,"deviceId"')).toBeNull();
    expect(parseDevicePinWrap('null')).toBeNull();
    expect(parseDevicePinWrap('[]')).toBeNull();
    expect(parseDevicePinWrap('"a string"')).toBeNull();
    expect(parseDevicePinWrap(null)).toBeNull();
  });

  it('leaves nothing behind when cleared', () => {
    // The path a burn, a revocation elsewhere and a wrap mismatch all take. A
    // record left behind would suppress the offer to set a PIN up again while
    // never working.
    const storage = fakeStorage();
    writeDevicePinWrap(storage, record());
    clearDevicePinWrap(storage);

    expect(storage.entries.size).toBe(0);
    expect(readDevicePinWrap(storage)).toBeNull();
    expect(hasDevicePinWrap(storage)).toBe(false);
  });

  it('reads as "no PIN here" when there is no storage at all', () => {
    // Private mode, or an origin with site data blocked.
    expect(readDevicePinWrap(null)).toBeNull();
    expect(() => clearDevicePinWrap(null)).not.toThrow();
  });

  it('refuses to claim an enrolment it could not store', () => {
    // Unlike the nudge's dismissal, where a failed write costs one repeated
    // toast: an enrolment that silently failed to persist would report success
    // and then meet the user with the passphrase form for ever, while a live
    // pepper row on the server said otherwise.
    expect(() => writeDevicePinWrap(null, record())).toThrow();
  });

  it('reports a storage that throws as no PIN rather than crashing a render', () => {
    const hostile: DevicePinStorage = {
      getItem: () => {
        throw new DOMException('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(readDevicePinWrap(hostile)).toBeNull();
  });
});

describe('what may be typed as a PIN', () => {
  it('accepts exactly six digits, twice over', () => {
    expect(pinProblem('012345')).toBeNull();
    expect(pinProblem('012345', '012345')).toBeNull();
  });

  it('names the length as the problem before it names the mismatch', () => {
    // Order matters for the message somebody reads while typing: "six digits"
    // is actionable on the first field, "those do not match" is not.
    expect(pinProblem('123', '456')).toMatch(/6 digits/);
  });

  it('refuses anything that is not six digits', () => {
    for (const pin of ['', '12345', '1234567', '12345a', '12 456', '١٢٣٤٥٦']) {
      expect(pinProblem(pin), pin).not.toBeNull();
    }
  });

  it('refuses two entries that differ', () => {
    expect(pinProblem('123456', '123457')).toMatch(/do not match/);
  });

  it('does not ask for a confirmation that was not offered', () => {
    // The lock screen asks once; the settings flow asks twice. One rule, one
    // parameter, rather than two nearly-identical validators.
    expect(pinProblem('123456')).toBeNull();
  });
});

describe('what may be *chosen* as a PIN', () => {
  it('refuses six of the same digit, all ten of them', () => {
    for (let digit = 0; digit <= 9; digit += 1) {
      const pin = String(digit).repeat(6);
      expect(weakPinProblem(pin), pin).not.toBeNull();
    }
  });

  it('refuses every straight run, up and down, including from zero', () => {
    for (const pin of [
      '012345',
      '123456',
      '234567',
      '345678',
      '456789',
      '987654',
      '876543',
      '765432',
      '654321',
      '543210',
    ]) {
      expect(weakPinProblem(pin), pin).not.toBeNull();
    }
  });

  it('says what to do rather than what was wrong', () => {
    expect(weakPinProblem('123456')).toMatch(/too easy to guess/);
  });

  it('accepts a PIN that is merely unmemorable', () => {
    // Nothing here is a repeat or a run. `112358` is the one that matters: a
    // rule that looked at "is it a recognisable sequence" rather than at the
    // step between digits would reject it, and rejecting a PIN for a reason
    // the person cannot see is how somebody ends up writing one down.
    for (const pin of ['274913', '480516', '112358', '111112', '210123', '024680']) {
      expect(weakPinProblem(pin), pin).toBeNull();
    }
  });

  it('leaves the length and digit rules to the rule that owns them', () => {
    // Not this function's complaint, so it does not make one — otherwise
    // `12345` would be reported as predictable rather than as short.
    for (const pin of ['', '1234', '12345a', '1234567', '١٢٣٤٥٦']) {
      expect(weakPinProblem(pin), pin).toBeNull();
    }
  });
});

describe('the enrolment gate the settings form runs before it encrypts anything', () => {
  it('names the length first, under the field that is short', () => {
    const problem = enrolmentPinProblem('123', '');

    expect(problem?.field).toBe('pin');
    expect(problem?.message).toMatch(/6 digits/);
  });

  it('rejects a predictable PIN before it asks whether it was typed twice', () => {
    // Both fields hold `123456`, so a match-first order would let it through to
    // the server. And the message belongs under the box that has to change.
    const problem = enrolmentPinProblem('123456', '123456');

    expect(problem?.field).toBe('pin');
    expect(problem?.message).toMatch(/too easy to guess/);
  });

  it('puts a mismatch under the confirmation box', () => {
    const problem = enrolmentPinProblem('274913', '274914');

    expect(problem?.field).toBe('confirm');
    expect(problem?.message).toMatch(/do not match/);
  });

  it('accepts a PIN that is six digits, unpredictable and typed twice', () => {
    expect(enrolmentPinProblem('274913', '274913')).toBeNull();
  });

  it('never stands between somebody and a PIN they have already enrolled', () => {
    // The unlock path deliberately does not call this. What opens the wrap is
    // whatever was enrolled — including a PIN chosen before this rule existed —
    // and a validator on the lock screen would be a lockout, not a policy.
    expect(pinProblem('123456')).toBeNull();
    expect(pinProblem('000000')).toBeNull();
  });
});
