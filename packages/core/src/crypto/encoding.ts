/**
 * Byte and string helpers used by the crypto layer.
 *
 * Everything here is Web Crypto or plain JavaScript — nothing Node-specific, so
 * the same code runs in a Cloudflare Worker, in the browser, and under Vitest.
 */

import type { Bytes } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Bytes {
  if (!Number.isInteger(length) || length < 1) {
    throw new TypeError('randomBytes requires a positive integer length');
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function utf8Encode(value: string): Bytes {
  return textEncoder.encode(value);
}

/** Throws on invalid UTF-8 rather than substituting replacement characters. */
export function utf8Decode(bytes: Bytes): string {
  return textDecoder.decode(bytes);
}

/**
 * base64url without padding (RFC 4648 §5).
 *
 * Used wherever key material or ciphertext crosses a text boundary — environment
 * variables, JSON, URLs. Unpadded so the value is safe in a URL path without
 * further escaping.
 */
export function toBase64Url(bytes: Bytes): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new TypeError('Not valid base64url');
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function concatBytes(...parts: readonly Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time byte comparison.
 *
 * Every comparison of a token hash, HMAC, or other attacker-influenced secret
 * must use this rather than `===` or a loop with an early return. A comparison
 * that exits on the first differing byte leaks, through timing, how many leading
 * bytes were correct — enough to reconstruct a value one byte at a time.
 *
 * The length is deliberately compared first and separately: lengths are not
 * secret, and short-circuiting on them avoids reading past either buffer.
 */
export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i]! ^ b[i]!;
  }
  return difference === 0;
}

/**
 * Overwrites a buffer holding key material.
 *
 * An honest note on what this does and does not achieve: JavaScript engines make
 * no guarantee that this is the only copy of the bytes, and a garbage-collected
 * runtime may have moved them already. This narrows the window in which a heap
 * snapshot yields a usable key; it does not close it. It is defence in depth, not
 * a control to rely on.
 */
export function zeroize(bytes: Bytes): void {
  bytes.fill(0);
}
