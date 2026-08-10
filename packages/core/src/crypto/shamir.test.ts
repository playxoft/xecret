import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from './encoding';
import { combine, split } from './shamir';
import type { ShamirShare } from './shamir';

/** Every k-sized subset of `items`. */
function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];

  const [head, ...rest] = items;
  return [...combinations(rest, k - 1).map((combo) => [head!, ...combo]), ...combinations(rest, k)];
}

describe('split and combine', () => {
  it('reconstructs from exactly the threshold number of shares', () => {
    const secret = randomBytes(32);
    const shares = split(secret, 3, 2);

    expect(shares).toHaveLength(3);
    expect(combine(shares.slice(0, 2))).toEqual(secret);
  });

  // The 2-of-3 escrow scheme in docs/security/key-recovery.md depends on this:
  // whichever two shares survive must work.
  it('reconstructs from ANY 2 of 3 shares', () => {
    const secret = randomBytes(32);
    const shares = split(secret, 3, 2);

    for (const pair of combinations(shares, 2)) {
      expect(combine(pair)).toEqual(secret);
    }
  });

  it('reconstructs from more shares than the threshold', () => {
    const secret = randomBytes(32);
    expect(combine(split(secret, 5, 3))).toEqual(secret);
  });

  it('works for other threshold schemes', () => {
    for (const [n, k] of [
      [2, 2],
      [5, 3],
      [10, 7],
      [255, 2],
    ] as const) {
      const secret = randomBytes(16);
      const shares = split(secret, n, k);
      expect(combine(shares.slice(0, k))).toEqual(secret);
    }
  });

  it('handles every byte value, including 0x00 and 0xff', () => {
    const secret = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) secret[i] = i;

    const shares = split(secret, 3, 2);
    expect(combine(shares.slice(0, 2))).toEqual(secret);
  });

  it('handles an all-zero secret', () => {
    const secret = new Uint8Array(32);
    expect(combine(split(secret, 3, 2).slice(0, 2))).toEqual(secret);
  });

  it('handles a single-byte secret', () => {
    const secret = new Uint8Array([42]);
    expect(combine(split(secret, 3, 2).slice(0, 2))).toEqual(secret);
  });

  it('is stable across many random trials', () => {
    for (let trial = 0; trial < 200; trial += 1) {
      const secret = randomBytes(32);
      const shares = split(secret, 3, 2);
      const [a, b] = combinations(shares, 2)[trial % 3]!;
      expect(combine([a!, b!])).toEqual(secret);
    }
  });
});

describe('security property', () => {
  /**
   * Below the threshold the scheme is information-theoretically secure: k-1
   * shares are consistent with every possible secret. The observable proxy is
   * that a single share carries no trace of the secret's bytes, and that shares
   * of the same secret differ completely from one another.
   */
  it('produces shares that do not contain the secret', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const shares = split(secret, 3, 2);

    for (const share of shares) {
      expect(toBase64Url(share.data)).not.toBe(toBase64Url(secret));
      // An all-identical secret must not yield an all-identical share.
      expect(new Set(share.data).size).toBeGreaterThan(1);
    }
  });

  it('produces different shares for the same secret on every split', () => {
    const secret = randomBytes(32);

    const first = toBase64Url(split(secret, 3, 2)[0]!.data);
    const second = toBase64Url(split(secret, 3, 2)[0]!.data);

    expect(first).not.toBe(second);
  });

  it('gives every share a distinct index starting at 1', () => {
    // Index 0 is the secret itself and must never be issued as a share.
    const shares = split(randomBytes(16), 5, 3);
    expect(shares.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('yields the wrong answer — not the secret — from too few shares', () => {
    const secret = randomBytes(32);
    const shares = split(secret, 3, 3);

    // Two shares of a 3-of-3 scheme interpolate to something, but not the secret.
    expect(combine(shares.slice(0, 2))).not.toEqual(secret);
  });
});

describe('input validation', () => {
  it('rejects an empty secret', () => {
    expect(() => split(new Uint8Array(0), 3, 2)).toThrow(TypeError);
  });

  it.each([
    [1, 2],
    [256, 2],
    [3, 1],
    [3, 4],
  ])('rejects shares=%i threshold=%i', (shares, threshold) => {
    expect(() => split(randomBytes(16), shares, threshold)).toThrow(TypeError);
  });

  it('rejects non-integer parameters', () => {
    expect(() => split(randomBytes(16), 3.5, 2)).toThrow(TypeError);
    expect(() => split(randomBytes(16), 3, 2.5)).toThrow(TypeError);
  });

  it('requires at least two shares to combine', () => {
    const shares = split(randomBytes(16), 3, 2);
    expect(() => combine(shares.slice(0, 1))).toThrow(TypeError);
    expect(() => combine([])).toThrow(TypeError);
  });

  it('rejects shares of differing lengths', () => {
    const shares = split(randomBytes(16), 3, 2);
    const truncated: ShamirShare = { index: 2, data: shares[1]!.data.slice(0, 8) };

    expect(() => combine([shares[0]!, truncated])).toThrow(TypeError);
  });

  // Duplicate x-coordinates make the interpolation singular. Without this check
  // the result would be silent garbage — the worst possible outcome during a
  // disaster-recovery drill.
  it('rejects duplicate share indices', () => {
    const shares = split(randomBytes(16), 3, 2);
    expect(() => combine([shares[0]!, shares[0]!])).toThrow(/distinct/);
  });

  it('rejects an out-of-range index', () => {
    const shares = split(randomBytes(16), 3, 2);
    expect(() => combine([{ index: 0, data: shares[0]!.data }, shares[1]!])).toThrow(TypeError);
    expect(() => combine([{ index: 256, data: shares[0]!.data }, shares[1]!])).toThrow(TypeError);
  });
});
