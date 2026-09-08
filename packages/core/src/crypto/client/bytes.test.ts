import { describe, expect, it } from 'vitest';
import { randomBytes } from '../encoding';
import {
  assertLength,
  copyBytes,
  fromHex,
  lengthPrefixed,
  normalizedUtf8,
  normalizeText,
  toHex,
  u32be,
} from './bytes';

describe('hex', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [0, 1, 12, 32, 64]) {
      const bytes = length === 0 ? new Uint8Array(0) : randomBytes(length);
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    }
  });

  it('renders lowercase, two characters per byte', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa9]))).toBe('000fffa9');
  });

  // Strict on input: a lookupHash that round-trips through hex must come back
  // character-identical, because it is compared against a stored string.
  it('rejects uppercase, odd length, and non-hex characters', () => {
    expect(() => fromHex('AABB')).toThrow(TypeError);
    expect(() => fromHex('abc')).toThrow(TypeError);
    expect(() => fromHex('zz')).toThrow(TypeError);
    expect(() => fromHex('0x1234')).toThrow(TypeError);
  });
});

describe('u32be', () => {
  it('encodes big-endian', () => {
    expect([...u32be(0)]).toEqual([0, 0, 0, 0]);
    expect([...u32be(1)]).toEqual([0, 0, 0, 1]);
    expect([...u32be(258)]).toEqual([0, 0, 1, 2]);
    expect([...u32be(0xffff_ffff)]).toEqual([255, 255, 255, 255]);
  });

  it('rejects anything that is not a 32-bit unsigned integer', () => {
    expect(() => u32be(-1)).toThrow(TypeError);
    expect(() => u32be(1.5)).toThrow(TypeError);
    expect(() => u32be(0x1_0000_0000)).toThrow(TypeError);
  });
});

describe('lengthPrefixed', () => {
  it('prefixes the length as four big-endian bytes', () => {
    expect([...lengthPrefixed(new Uint8Array([9, 9, 9]))]).toEqual([0, 0, 0, 3, 9, 9, 9]);
    expect([...lengthPrefixed(new Uint8Array(0))]).toEqual([0, 0, 0, 0]);
  });

  // The property the whole canonicalisation rests on: no two field sequences
  // can produce the same byte string.
  it('is unambiguous — a boundary cannot be moved without changing the bytes', () => {
    const split = [...lengthPrefixed(new Uint8Array([1])), ...lengthPrefixed(new Uint8Array([2]))];
    const joined = [...lengthPrefixed(new Uint8Array([1, 2]))];
    expect(split).not.toEqual(joined);
  });
});

describe('normalisation', () => {
  const decomposed = 'cafe\u0301';
  const composed = 'caf\u00e9';

  it('maps both spellings of a character to the same bytes', () => {
    expect(normalizeText(decomposed)).toBe(composed);
    expect(toHex(normalizedUtf8(decomposed))).toBe(toHex(normalizedUtf8(composed)));
  });

  // Without this, the same passphrase typed on macOS and on Windows derives two
  // different keys and the second machine reports "wrong passphrase" forever.
  it('actually changes the bytes it is given', () => {
    expect(new TextEncoder().encode(decomposed)).not.toEqual(normalizedUtf8(decomposed));
  });
});

describe('copyBytes and assertLength', () => {
  it('copies rather than aliases', () => {
    const source = new Uint8Array([1, 2, 3]);
    const copy = copyBytes(source);

    copy[0] = 9;
    expect(source[0]).toBe(1);
  });

  it('asserts an exact length without echoing the material', () => {
    expect(() => assertLength(new Uint8Array(31), 32, 'key')).toThrow(TypeError);
    expect(() => assertLength(new Uint8Array(32), 32, 'key')).not.toThrow();

    try {
      assertLength(new Uint8Array([0xde, 0xad]), 32, 'key');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('key must be 32 bytes');
    }
  });
});
