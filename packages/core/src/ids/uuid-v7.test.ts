import { afterEach, describe, expect, it } from 'vitest';
import {
  __setClockForTesting,
  formatUuid,
  isUuid,
  uuidv7,
  uuidv7Bytes,
  uuidv7Timestamp,
} from './uuid-v7';

afterEach(() => {
  __setClockForTesting(null);
});

describe('uuidv7 format', () => {
  it('produces a canonical lowercase hyphenated string', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isUuid(uuidv7())).toBe(true);
    }
  });

  it('sets the version nibble to 7', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(uuidv7()[14]).toBe('7');
    }
  });

  it('sets the RFC 4122 variant bits to 0b10', () => {
    for (let i = 0; i < 100; i += 1) {
      const variantNibble = Number.parseInt(uuidv7()[19]!, 16);
      expect(variantNibble & 0b1100).toBe(0b1000);
    }
  });

  it('is 16 bytes in raw form', () => {
    expect(uuidv7Bytes()).toHaveLength(16);
  });

  it('never repeats across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(uuidv7());
    expect(seen.size).toBe(20_000);
  });
});

describe('uuidv7 timestamp', () => {
  it('embeds the current time', () => {
    const before = Date.now();
    const ts = uuidv7Timestamp(uuidv7());
    const after = Date.now();

    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('round-trips a fixed timestamp exactly', () => {
    const fixed = 1_760_000_000_000;
    __setClockForTesting(() => fixed);
    expect(uuidv7Timestamp(uuidv7())).toBe(fixed);
  });

  it('handles a timestamp beyond the 32-bit boundary', () => {
    // 2^40 ms is far past any 32-bit arithmetic mistake in the byte packing.
    const large = 2 ** 41 + 12_345;
    __setClockForTesting(() => large);
    expect(uuidv7Timestamp(uuidv7())).toBe(large);
  });

  it('rejects anything that is not a canonical UUID', () => {
    expect(() => uuidv7Timestamp('not-a-uuid')).toThrow(TypeError);
    // Uppercase is deliberately rejected rather than normalised.
    expect(() => uuidv7Timestamp(uuidv7().toUpperCase())).toThrow(TypeError);
  });
});

describe('uuidv7 monotonicity', () => {
  // Without a sub-millisecond counter, `ORDER BY id` would silently disagree
  // with `ORDER BY created_at` for rows written in the same millisecond.
  it('sorts in creation order within a single frozen millisecond', () => {
    __setClockForTesting(() => 1_760_000_000_000);

    const ids = Array.from({ length: 2000 }, () => uuidv7());
    const sorted = [...ids].sort();

    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts in creation order across advancing milliseconds', () => {
    let t = 1_760_000_000_000;
    __setClockForTesting(() => t);

    const ids: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      ids.push(uuidv7());
      if (i % 5 === 0) t += 1;
    }

    expect([...ids].sort()).toEqual(ids);
  });

  // A clock that steps backwards (NTP correction, VM migration) must not produce
  // identifiers that sort before ones already handed out.
  it('stays monotonic when the clock moves backwards', () => {
    let t = 1_760_000_000_000;
    __setClockForTesting(() => t);

    const before = uuidv7();
    t -= 5_000;
    const ids = Array.from({ length: 100 }, () => uuidv7());

    expect([...ids].sort()).toEqual(ids);
    expect(before < ids[0]!).toBe(true);
  });

  // The 12-bit counter holds 4096 values and is seeded into the low quarter,
  // so a burst larger than the remaining headroom must borrow from the timestamp
  // rather than wrap and emit a value that sorts backwards.
  it('stays monotonic when the counter overflows within one millisecond', () => {
    __setClockForTesting(() => 1_760_000_000_000);

    const ids = Array.from({ length: 10_000 }, () => uuidv7());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('formatUuid', () => {
  it('formats a known byte array', () => {
    const bytes = new Uint8Array([
      0x01, 0x8f, 0x2a, 0x3b, 0x4c, 0x5d, 0x76, 0xef, 0x8a, 0x9b, 0xac, 0xbd, 0xce, 0xdf, 0xe0,
      0xf1,
    ]);
    expect(formatUuid(bytes)).toBe('018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f1');
  });

  it('rejects a wrong-length input rather than producing a malformed UUID', () => {
    expect(() => formatUuid(new Uint8Array(15))).toThrow(TypeError);
    expect(() => formatUuid(new Uint8Array(17))).toThrow(TypeError);
  });
});

describe('isUuid', () => {
  it.each(['018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f1', '00000000-0000-0000-0000-000000000000'])(
    'accepts %s',
    (value) => {
      expect(isUuid(value)).toBe(true);
    },
  );

  it.each([
    ['', 'empty'],
    ['018f2a3b4c5d76ef8a9bacbdcedfe0f1', 'unhyphenated'],
    ['018F2A3B-4C5D-76EF-8A9B-ACBDCEDFE0F1', 'uppercase'],
    ['{018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f1}', 'braced'],
    ['urn:uuid:018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f1', 'URN form'],
    ['018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f', 'too short'],
    ['018f2a3b-4c5d-76ef-8a9b-acbdcedfe0f1x', 'trailing character'],
    ['018f2a3g-4c5d-76ef-8a9b-acbdcedfe0f1', 'non-hex character'],
  ])('rejects %s (%s)', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
