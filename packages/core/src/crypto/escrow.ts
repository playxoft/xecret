import { fromBase64Url, toBase64Url } from './encoding';
import { combine, split } from './shamir';
import type { ShamirShare } from './shamir';
import type { Bytes } from './types';

/**
 * The escrow share wire format, and the fingerprint that validates a recovery.
 *
 * This lives in `packages/core` rather than in `scripts/keygen.ts` for one
 * reason: it is the format a human will type back in, by hand, on the worst day
 * this product ever has. It has to be tested, and code inside a CLI script that
 * nothing imports does not get tested. `scripts/keygen.ts` is now a thin
 * presentation layer over these functions.
 *
 * ## Format
 *
 *     xecret-share-v1.<index>.<base64url data>.<fingerprint>
 *
 * Four dot-separated fields, none of which can contain a dot: the prefix is
 * literal, the index is an integer, the payload is base64url (whose alphabet is
 * `[A-Za-z0-9_-]`), and the fingerprint is hex. The encoding is therefore
 * unambiguous without escaping or length prefixes.
 *
 * Each field earns its place:
 *
 * - **The version prefix** means a future format change cannot be silently
 *   misread as this one. A share is written on paper and may be read back years
 *   later, by which time the software has moved on.
 * - **The index** is required by Lagrange interpolation — a share is the value
 *   of a polynomial at `x = index`, and without knowing `x` the value is
 *   useless. It is not secret.
 * - **The fingerprint** is carried on every share so that a set of shares can be
 *   checked for agreement *before* reconstruction, and the reconstructed key
 *   checked *after*. A wrong or mixed set of shares produces a plausible-looking
 *   key rather than an error — Shamir has no built-in integrity — so without
 *   this, a botched recovery would be discovered only when decryption started
 *   returning garbage.
 */

export const SHARE_PREFIX = 'xecret-share-v1';

/** Bytes of SHA-256 kept in the fingerprint. 64 bits: identification, not integrity. */
const FINGERPRINT_BYTES = 8;

/**
 * A short public identifier for a key.
 *
 * Safe to write down, commit to the runbook, and read aloud over the phone: it
 * is a truncated SHA-256 of the key. Truncation is deliberate and harmless here
 * — the purpose is to distinguish "this is the key we meant" from "this is some
 * other key", not to resist a collision attack by someone who already holds the
 * key material.
 */
export async function fingerprint(key: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', key);

  return [...new Uint8Array(digest).slice(0, FINGERPRINT_BYTES)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function encodeShare(share: ShamirShare, keyFingerprint: string): string {
  return `${SHARE_PREFIX}.${share.index}.${toBase64Url(share.data)}.${keyFingerprint}`;
}

export interface DecodedShare {
  share: ShamirShare;
  fingerprint: string;
}

/**
 * Parses one share.
 *
 * Every failure is a distinct, actionable message. This runs during an incident,
 * against a value someone has just typed off a piece of paper, and "invalid
 * share" would leave them guessing which of three shares they mistyped.
 */
export function decodeShare(encoded: string): DecodedShare {
  const parts = encoded.trim().split('.');

  if (parts.length !== 4 || parts[0] !== SHARE_PREFIX) {
    throw new EscrowFormatError(
      `Not a valid share. Expected "${SHARE_PREFIX}.<index>.<data>.<fingerprint>"`,
    );
  }

  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 1 || index > 255) {
    // Bounded by the field: shares are points on a polynomial over GF(2^8), so
    // x = 0 is the secret itself and x > 255 does not exist.
    throw new EscrowFormatError(`Share index "${parts[1]}" is out of range (expected 1–255)`);
  }

  let data: Bytes;
  try {
    data = fromBase64Url(parts[2]!);
  } catch {
    throw new EscrowFormatError(`Share ${index} payload is not valid base64url`);
  }

  if (data.length === 0) throw new EscrowFormatError(`Share ${index} carries no data`);

  const keyFingerprint = parts[3]!;
  if (!/^[0-9a-f]+$/.test(keyFingerprint)) {
    throw new EscrowFormatError(`Share ${index} fingerprint is not hexadecimal`);
  }

  return { share: { index, data }, fingerprint: keyFingerprint };
}

export class EscrowFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscrowFormatError';
  }
}

/**
 * Raised when shares do not reconstruct the key they claim to.
 *
 * Separate from a format error because the operator response differs: a format
 * error means "you mistyped it", this means "STOP, do not use this key".
 */
export class EscrowVerificationError extends Error {
  constructor(
    readonly expected: string,
    readonly computed: string,
  ) {
    super(
      `Fingerprint mismatch.\n  expected ${expected}\n  computed ${computed}\n\n` +
        'STOP. Do not use this key. A wrong key silently produces garbage rather\n' +
        'than failing loudly. Re-check that the shares are correct and complete.',
    );
    this.name = 'EscrowVerificationError';
  }
}

/** Splits a key into encoded shares, ready to be printed and distributed. */
export async function splitKeyIntoShares(
  key: Bytes,
  totalShares: number,
  threshold: number,
): Promise<{ fingerprint: string; shares: string[] }> {
  const keyFingerprint = await fingerprint(key);
  const parts = split(key, totalShares, threshold);

  try {
    return {
      fingerprint: keyFingerprint,
      shares: parts.map((p) => encodeShare(p, keyFingerprint)),
    };
  } finally {
    // The encoded strings are what the caller needs; the raw share bytes are
    // another copy of key-equivalent material and do not need to outlive this
    // function.
    for (const part of parts) part.data.fill(0);
  }
}

/**
 * Reconstructs a key from encoded shares and verifies it.
 *
 * The verification is not optional and there is no flag to skip it. Shamir
 * reconstruction always yields *a* value: feed it shares from two different
 * keys, or one share with a typo, and it returns 32 plausible bytes with no
 * error. Everything downstream would then decrypt to garbage, and the operator
 * would conclude the ciphertext was lost rather than that the recovery was wrong.
 *
 * On mismatch the reconstructed bytes are wiped before throwing, so a caught
 * error cannot be used to reach a key that failed its check.
 */
export async function recoverKeyFromShares(
  encodedShares: readonly string[],
  expectedFingerprint?: string,
): Promise<{ key: Bytes; fingerprint: string }> {
  if (encodedShares.length < 2) {
    throw new EscrowFormatError('At least 2 shares are required to reconstruct a key');
  }

  const decoded = encodedShares.map(decodeShare);

  // Checked before reconstruction: disagreeing fingerprints mean the shares are
  // from different keys, and saying so is more useful than reporting a mismatch
  // against a key that was never going to be produced.
  const claimed = new Set(decoded.map((d) => d.fingerprint));
  if (claimed.size > 1) {
    throw new EscrowFormatError('Shares belong to different keys — their fingerprints disagree');
  }

  const indices = new Set(decoded.map((d) => d.share.index));
  if (indices.size !== decoded.length) {
    // Two copies of one share are one share. Without this check a 2-of-3 scheme
    // would appear to be satisfied by presenting share 1 twice, and would
    // silently reconstruct the wrong value.
    throw new EscrowFormatError('The same share was supplied more than once');
  }

  const key = combine(decoded.map((d) => d.share));
  const computed = await fingerprint(key);
  const expected = expectedFingerprint ?? [...claimed][0]!;

  if (computed !== expected) {
    key.fill(0);
    throw new EscrowVerificationError(expected, computed);
  }

  return { key, fingerprint: computed };
}
