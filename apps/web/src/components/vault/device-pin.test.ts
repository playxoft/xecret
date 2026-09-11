import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@xecret/core/ids';

import {
  clearDevicePinWrap,
  DEVICE_PIN_WRAP_VERSION,
  parseDevicePinWrap,
  pinProblem,
  readDevicePinWrap,
  writeDevicePinWrap,
} from './device-pin';
import type { DevicePinStorage, DevicePinWrap } from './device-pin';
import { DEVICE_PIN_WRAP_KEY, hasDevicePinWrap } from './unlock-nudge';

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
