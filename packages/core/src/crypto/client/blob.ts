/**
 * The `xk2` blob format: every stored zero-knowledge artifact, as one ASCII
 * string.
 *
 *     xk2.<algo>.<base64url payload>
 *
 * Three dot-separated fields. Neither the version nor the algorithm tag can
 * contain a dot and the base64url alphabet excludes it, so the encoding is
 * unambiguous without escaping or length prefixes — the same reasoning as the
 * `xecret-share-v1.` format in `crypto/escrow.ts`.
 *
 * **Parsers reject anything they do not recognise, loudly.** An unknown version,
 * an unknown algorithm tag, a payload below the minimum for its type, or a
 * payload that is not valid unpadded base64url is a hard error — never a
 * fallback and never a guess. A blob written by a future version must fail to
 * parse rather than be misread as this one, because the alternative is a silent
 * misinterpretation of key material.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §2.
 */

import { fromBase64Url, toBase64Url } from '../encoding';
import type { Bytes, SealedBytes } from '../types';
import { IV_LENGTH } from '../aead';

/** The one blob version this module reads and writes. */
export const BLOB_VERSION = 'xk2';

/**
 * The algorithm tag registry (spec §2.1).
 *
 * The tag names the *construction*, not the purpose. Purpose is carried by the
 * AAD and by the column the blob lives in; a blob moved to the wrong column
 * fails to decrypt because its AAD no longer matches.
 */
export const BLOB_ALGORITHMS = ['gcm', 'x25519', 'ed25519'] as const;

export type BlobAlgorithm = (typeof BLOB_ALGORITHMS)[number];

/**
 * Minimum payload sizes, in bytes.
 *
 * - `gcm`: iv(12) ‖ tag(16), an empty plaintext.
 * - `x25519`: ephemeralPub(32) ‖ iv(12) ‖ tag(16).
 * - `ed25519`: a detached signature, which is exactly 64.
 */
const MIN_PAYLOAD_BYTES: Record<BlobAlgorithm, number> = {
  gcm: IV_LENGTH + 16,
  x25519: 32 + IV_LENGTH + 16,
  ed25519: 64,
};

const EXACT_PAYLOAD_BYTES: Partial<Record<BlobAlgorithm, number>> = { ed25519: 64 };

/**
 * Raised when a blob is not the shape this version understands.
 *
 * Distinct from {@link DecryptionError} on purpose, and the distinction is
 * narrow: this says *"that is not an xk2 blob of the type expected here"*, which
 * is a fact about the string an attacker already holds. Anything that depends on
 * key material — a wrong key, a wrong AAD, a flipped ciphertext bit — surfaces
 * as the uniform `DecryptionError` instead, carrying no detail.
 *
 * Messages never include the offending payload: blobs are key material and
 * error messages reach logs.
 */
export class BlobFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobFormatError';
  }
}

function isBlobAlgorithm(value: string): value is BlobAlgorithm {
  return (BLOB_ALGORITHMS as readonly string[]).includes(value);
}

/** Renders `xk2.<algo>.<b64url payload>`. */
export function formatBlob(algorithm: BlobAlgorithm, payload: Bytes): string {
  if (!isBlobAlgorithm(algorithm)) {
    throw new BlobFormatError('Unknown blob algorithm');
  }

  const minimum = MIN_PAYLOAD_BYTES[algorithm];
  if (payload.length < minimum) {
    throw new BlobFormatError('Blob payload is shorter than its algorithm allows');
  }

  return `${BLOB_VERSION}.${algorithm}.${toBase64Url(payload)}`;
}

/**
 * Parses a blob, requiring a specific algorithm.
 *
 * The caller always knows which construction it expects — the column it read
 * from says so — and passing it in means a `gcm` blob presented where a sealed
 * box belongs is rejected at the format layer rather than producing a confusing
 * decryption failure.
 */
export function parseBlob(blob: string, expected: BlobAlgorithm): Bytes {
  if (typeof blob !== 'string') {
    throw new BlobFormatError('Blob must be a string');
  }

  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new BlobFormatError('Blob must have the form xk2.<algorithm>.<payload>');
  }

  if (parts[0] !== BLOB_VERSION) {
    throw new BlobFormatError('Unsupported blob version');
  }

  const tag = parts[1]!;
  if (!isBlobAlgorithm(tag)) {
    throw new BlobFormatError('Unsupported blob algorithm');
  }

  if (tag !== expected) {
    throw new BlobFormatError('Blob algorithm is not the one expected here');
  }

  let payload: Bytes;
  try {
    payload = fromBase64Url(parts[2]!);
  } catch {
    throw new BlobFormatError('Blob payload is not valid unpadded base64url');
  }

  const exact = EXACT_PAYLOAD_BYTES[tag];
  if (exact !== undefined && payload.length !== exact) {
    throw new BlobFormatError('Blob payload is not the required length');
  }

  if (payload.length < MIN_PAYLOAD_BYTES[tag]) {
    throw new BlobFormatError('Blob payload is shorter than its algorithm allows');
  }

  return payload;
}

/** Renders `xk2.gcm.<b64url(iv ‖ ciphertext‖tag)>`. */
export function formatGcmBlob(sealed: SealedBytes): string {
  if (sealed.iv.length !== IV_LENGTH) {
    throw new BlobFormatError('An AES-GCM blob carries a 12-byte IV');
  }

  const payload = new Uint8Array(sealed.iv.length + sealed.ciphertext.length);
  payload.set(sealed.iv, 0);
  payload.set(sealed.ciphertext, sealed.iv.length);
  return formatBlob('gcm', payload);
}

/** Splits an `xk2.gcm.` blob back into its IV and ciphertext. */
export function parseGcmBlob(blob: string): SealedBytes {
  const payload = parseBlob(blob, 'gcm');
  return {
    iv: payload.slice(0, IV_LENGTH),
    ciphertext: payload.slice(IV_LENGTH),
  };
}
