import { randomBytes } from './encoding';
import type { Bytes } from './types';

/**
 * Shamir's Secret Sharing over GF(2^8).
 *
 * Used once, offline, to split the Root KEK into escrow shares — never on a
 * request path. See docs/security/key-recovery.md.
 *
 * ## Why this is implemented here rather than taken from a dependency
 *
 * "Never invent cryptography" is about algorithms and primitives. This is
 * neither: Shamir's scheme is a 1979 paper, information-theoretically secure,
 * and consists of polynomial evaluation and Lagrange interpolation over a finite
 * field. There is no cipher, no key schedule, and no security parameter to get
 * subtly wrong.
 *
 * The reason to implement rather than depend: this code runs during the key
 * ceremony, on an air-gapped machine, on the one secret whose loss ends the
 * company. A dependency there is a supply-chain risk with a blast radius of
 * "every customer's data", for the sake of eighty lines of arithmetic that can
 * be read end to end in a few minutes.
 *
 * ## Security property
 *
 * With threshold `k`, any `k` shares reconstruct the secret exactly, and any
 * `k-1` shares reveal *nothing* — not "are computationally hard to break", but
 * are consistent with every possible secret of the same length.
 *
 * The field arithmetic is byte-wise, so timing does not depend on the secret in
 * any way that matters for an offline, one-shot operation.
 */

/** log/exp tables for GF(2^8) with the AES reduction polynomial 0x11b, generator 3. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;

    // x * 3 == (x * 2) XOR x, where x * 2 is a left shift reduced mod 0x11b.
    let doubled = x << 1;
    if (doubled & 0x100) doubled ^= 0x11b;
    x = (x ^ doubled) & 0xff;
  }
  // Duplicated so `LOG[a] + LOG[b]` can index without a modulo.
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP[LOG[a]! + 255 - LOG[b]!]!;
}

export interface ShamirShare {
  /** The share's x-coordinate, 1–255. Zero is the secret itself and is never issued. */
  index: number;
  /** One byte of share data per byte of secret. */
  data: Bytes;
}

/**
 * Splits `secret` into `shares` pieces, any `threshold` of which reconstruct it.
 */
export function split(secret: Bytes, shares: number, threshold: number): ShamirShare[] {
  if (secret.length === 0) {
    throw new TypeError('Cannot split an empty secret');
  }
  if (!Number.isInteger(shares) || shares < 2 || shares > 255) {
    throw new TypeError('shares must be an integer between 2 and 255');
  }
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new TypeError('threshold must be an integer of at least 2');
  }
  if (threshold > shares) {
    // Otherwise the secret would be unrecoverable the moment it was split.
    throw new TypeError('threshold cannot exceed the number of shares');
  }

  const result: ShamirShare[] = Array.from({ length: shares }, (_, i) => ({
    index: i + 1,
    data: new Uint8Array(secret.length),
  }));

  for (let byteIndex = 0; byteIndex < secret.length; byteIndex += 1) {
    // A degree-(threshold-1) polynomial whose constant term is the secret byte.
    const coefficients = new Uint8Array(threshold);
    coefficients[0] = secret[byteIndex]!;
    // Random higher coefficients are what make k-1 shares reveal nothing.
    coefficients.set(randomBytes(threshold - 1), 1);

    for (const share of result) {
      share.data[byteIndex] = evaluate(coefficients, share.index);
    }

    coefficients.fill(0);
  }

  return result;
}

/** Reconstructs a secret from `threshold` or more shares. */
export function combine(shares: readonly ShamirShare[]): Bytes {
  if (shares.length < 2) {
    throw new TypeError('At least 2 shares are required');
  }

  const length = shares[0]!.data.length;
  if (shares.some((share) => share.data.length !== length)) {
    throw new TypeError('All shares must be the same length');
  }

  const indices = shares.map((share) => share.index);
  if (indices.some((index) => index < 1 || index > 255)) {
    throw new TypeError('Share indices must be between 1 and 255');
  }
  if (new Set(indices).size !== indices.length) {
    // Duplicate x-coordinates make the interpolation singular; without this
    // check the result would be silent garbage rather than an error.
    throw new TypeError('Share indices must be distinct');
  }

  const secret = new Uint8Array(length);

  for (let byteIndex = 0; byteIndex < length; byteIndex += 1) {
    // Lagrange interpolation evaluated at x = 0.
    let accumulator = 0;

    for (let i = 0; i < shares.length; i += 1) {
      let basis = 1;
      for (let j = 0; j < shares.length; j += 1) {
        if (i === j) continue;
        basis = mul(basis, div(indices[j]!, indices[i]! ^ indices[j]!));
      }
      accumulator ^= mul(shares[i]!.data[byteIndex]!, basis);
    }

    secret[byteIndex] = accumulator;
  }

  return secret;
}

/** Horner evaluation of a polynomial at `x`. */
function evaluate(coefficients: Bytes, x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) {
    result = mul(result, x) ^ coefficients[i]!;
  }
  return result;
}
