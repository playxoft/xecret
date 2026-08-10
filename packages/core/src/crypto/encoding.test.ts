import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  fromBase64Url,
  randomBytes,
  timingSafeEqual,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  zeroize,
} from './encoding';

describe('randomBytes', () => {
  it('returns the requested length', () => {
    expect(randomBytes(1)).toHaveLength(1);
    expect(randomBytes(32)).toHaveLength(32);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => toBase64Url(randomBytes(16))));
    expect(seen.size).toBe(1000);
  });

  it('rejects a non-positive or fractional length rather than returning empty', () => {
    expect(() => randomBytes(0)).toThrow(TypeError);
    expect(() => randomBytes(-1)).toThrow(TypeError);
    expect(() => randomBytes(1.5)).toThrow(TypeError);
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes, including every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(fromBase64Url(toBase64Url(all))).toEqual(all);
  });

  it('round-trips every length modulo 4, where padding rules differ', () => {
    for (const length of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = randomBytes(length);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('emits no padding and no URL-unsafe characters', () => {
    for (let i = 1; i <= 40; i += 1) {
      const encoded = toBase64Url(randomBytes(i));
      expect(encoded).not.toContain('=');
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
    }
  });

  it('encodes a known vector', () => {
    // "xecret" -> base64 "eGVjcmV0"
    expect(toBase64Url(utf8Encode('xecret'))).toBe('eGVjcmV0');
  });

  it('rejects input outside the base64url alphabet', () => {
    expect(() => fromBase64Url('not valid!')).toThrow(TypeError);
    expect(() => fromBase64Url('has+plus')).toThrow(TypeError);
    expect(() => fromBase64Url('has/slash')).toThrow(TypeError);
    expect(() => fromBase64Url('padded==')).toThrow(TypeError);
  });
});

describe('utf8', () => {
  it('round-trips multibyte text', () => {
    for (const value of ['ascii', 'héllo wörld', '日本語', '🔐🗝️', '']) {
      expect(utf8Decode(utf8Encode(value))).toBe(value);
    }
  });

  it('throws on malformed UTF-8 instead of silently substituting', () => {
    // A lone continuation byte. Silent replacement would corrupt a secret value
    // without anyone noticing.
    expect(() => utf8Decode(new Uint8Array([0x80]))).toThrow();
  });
});

describe('timingSafeEqual', () => {
  it('is true only for identical content', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('is false for different lengths', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('detects a difference in any position, including the last byte', () => {
    const base = new Uint8Array(32).fill(7);
    for (const index of [0, 15, 31]) {
      const other = new Uint8Array(base);
      other[index] = 8;
      expect(timingSafeEqual(base, other)).toBe(false);
    }
  });
});

describe('concatBytes', () => {
  it('joins in order', () => {
    expect(
      concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])),
    ).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('handles empty inputs', () => {
    expect(concatBytes()).toEqual(new Uint8Array(0));
    expect(concatBytes(new Uint8Array(0), new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  });
});

describe('zeroize', () => {
  it('overwrites every byte', () => {
    const bytes = randomBytes(32);
    zeroize(bytes);
    expect([...bytes].every((b) => b === 0)).toBe(true);
  });
});
