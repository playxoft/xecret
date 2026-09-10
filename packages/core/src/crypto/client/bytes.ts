/**
 * Byte helpers used by the client-side (zero-knowledge) crypto only.
 *
 * `crypto/encoding.ts` already carries the helpers shared with the server
 * envelope — random bytes, base64url, `timingSafeEqual`, `zeroize`. What is here
 * is what the `xk2` formats additionally need: hexadecimal, big-endian length
 * prefixes, Unicode normalisation, and one copy helper.
 *
 * Everything in `crypto/client/` is browser-safe by rule: Web Crypto,
 * `@noble/*`, and plain JavaScript. No `node:` imports, no `Buffer`.
 * See docs/security/e2ee-crypto-spec.md §11.
 */

import type { Bytes } from '../types';

const HEX_DIGITS = '0123456789abcdef';

/** Lowercase hex, no separators. The encoding the spec and vector files use. */
export function toHex(bytes: Bytes): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;
    out += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 0x0f]!;
  }
  return out;
}

/**
 * Parses lowercase hex.
 *
 * Deliberately strict — lowercase only, even length, nothing else — for the
 * reason `isUuid` gives: these values are compared against stored ones, and
 * accepting several spellings of the same bytes is how inconsistent-comparison
 * bugs start. A `lookupHash` that round-trips through hex must come back
 * character-identical.
 */
export function fromHex(value: string): Bytes {
  if (!/^([0-9a-f]{2})*$/.test(value)) {
    throw new TypeError('Not valid lowercase hexadecimal');
  }

  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A 32-bit unsigned integer, big-endian. The length prefix of spec §6.1. */
export function u32be(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError('u32be requires an integer in 0…2^32-1');
  }

  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/**
 * `lp(x) = u32be(len(x)) ‖ x` — the canonical field encoding of spec §6.1.
 *
 * Applied to fixed-width fields as well as variable-length ones. Four redundant
 * bytes per field remove the question of which implementation considers which
 * field fixed, and that question is exactly the sort that holds right up until
 * someone changes a UUID representation.
 */
export function lengthPrefixed(value: Bytes): Bytes {
  const out = new Uint8Array(4 + value.length);
  out.set(u32be(value.length), 0);
  out.set(value, 4);
  return out;
}

/**
 * Unicode NFC normalisation.
 *
 * Mandatory for every human-supplied string entering a KDF or an AEAD (spec
 * §1.3). A passphrase containing `é` is two code points on macOS and one on
 * Windows; without this the same passphrase typed on two machines derives two
 * different keys, and the second machine reports "wrong passphrase" forever.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFC');
}

const textEncoder = new TextEncoder();

/** NFC-normalised UTF-8 bytes. The only form text enters a KDF or an AEAD in. */
export function normalizedUtf8(value: string): Bytes {
  return textEncoder.encode(normalizeText(value));
}

/**
 * Copies any `Uint8Array` into an `ArrayBuffer`-backed one.
 *
 * `@noble/*` returns plain `Uint8Array`, whose backing buffer TypeScript models
 * as possibly shared; Web Crypto accepts only `ArrayBuffer`-backed views. This
 * is the one-line bridge, kept in a named function so the copy is visible rather
 * than hidden behind a cast that would also silence a real mistake.
 */
export function copyBytes(source: Uint8Array): Bytes {
  const out = new Uint8Array(source.length);
  out.set(source);
  return out;
}

/** Asserts an exact byte length, without echoing the material into the message. */
export function assertLength(value: Bytes, expected: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== expected) {
    throw new TypeError(`${label} must be ${expected} bytes`);
  }
}
