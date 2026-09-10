/**
 * The two per-principal keypairs: X25519 for sealing, Ed25519 for signing.
 *
 * One curve, one code path, no feature detection and no P-256 fallback — ADR
 * 0009 settles that. `@noble/curves` runs identically in a browser, in a Worker,
 * and under Node, so there is one implementation to review rather than a
 * primary and a fallback that differ in exactly the cases nobody tests.
 *
 * ## Sizes, and which private form is stored
 *
 * Both private keys are 32 bytes: the X25519 scalar, and the Ed25519 **seed**
 * — not its 64-byte expanded form. Both public keys are 32 bytes and are stored
 * in plaintext. The private halves are stored only as `xk2.gcm.` blobs under the
 * User Key (`wraps.ts`), and never leave the client in any other form.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §1.1, §2.2 types 4–5, §10.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { fromBase64Url, randomBytes, toBase64Url } from '../encoding';
import type { Bytes } from '../types';
import { assertLength, copyBytes } from './bytes';
import { deriveKey, HKDF_INFO } from './hkdf';

export const PUBLIC_KEY_BYTES = 32;
export const PRIVATE_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

/** A 32-byte private scalar or seed with its 32-byte public half. */
export interface KeyPair {
  publicKey: Bytes;
  privateKey: Bytes;
}

/** Derives the X25519 public key for a private scalar. */
export function encryptionPublicKey(privateKey: Bytes): Bytes {
  assertLength(privateKey, PRIVATE_KEY_BYTES, 'X25519 private key');
  return copyBytes(x25519.getPublicKey(privateKey));
}

/** Derives the Ed25519 public key for a 32-byte seed. */
export function signingPublicKey(privateSeed: Bytes): Bytes {
  assertLength(privateSeed, PRIVATE_KEY_BYTES, 'Ed25519 private seed');
  return copyBytes(ed25519.getPublicKey(privateSeed));
}

/**
 * A fresh X25519 keypair, for receiving sealed EDK and EHK grants.
 *
 * The scalar is 32 CSPRNG bytes from `crypto.getRandomValues` — the same source
 * every other random value in xecret comes from. X25519 clamps internally, so
 * any 32 bytes are a valid scalar.
 */
export function generateEncryptionKeyPair(): KeyPair {
  const privateKey = randomBytes(PRIVATE_KEY_BYTES);
  return { privateKey, publicKey: encryptionPublicKey(privateKey) };
}

/** A fresh Ed25519 keypair, for signing grants at creation. */
export function generateSigningKeyPair(): KeyPair {
  const privateKey = randomBytes(PRIVATE_KEY_BYTES);
  return { privateKey, publicKey: signingPublicKey(privateKey) };
}

/**
 * Encodes a 32-byte public key for transport.
 *
 * Public keys are stored as raw bytes (`user_keys.encPublicKey` is `bytea`) and
 * carry no version prefix — there is no `xk2.` blob type for them, because there
 * is nothing to misread: a key is 32 bytes of a named curve, and the algorithm
 * lives in its own column. This is the JSON form for an API body.
 */
export function encodePublicKey(publicKey: Bytes): string {
  assertLength(publicKey, PUBLIC_KEY_BYTES, 'public key');
  return toBase64Url(publicKey);
}

/** Parses a transported public key, rejecting anything not exactly 32 bytes. */
export function decodePublicKey(value: string): Bytes {
  let bytes: Bytes;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new TypeError('public key is not valid unpadded base64url');
  }

  assertLength(bytes, PUBLIC_KEY_BYTES, 'public key');
  return bytes;
}

/**
 * Derives the invitation keypair from an invite fragment's seed (spec §10).
 *
 * The fragment never reaches the server: the emailed link carries only the
 * `xin_…` token, and the fragment travels by a different channel. A leaked email
 * alone therefore decrypts nothing. The inviter uploads only the public half and
 * seals the relevant grants to it; the invitee re-derives the private half from
 * the string they were sent.
 */
export async function deriveInviteKeyPair(seed: Bytes): Promise<KeyPair> {
  assertLength(seed, 16, 'invite fragment seed');

  const privateKey = await deriveKey({ ikm: seed, info: HKDF_INFO.inviteKey });
  return { privateKey, publicKey: encryptionPublicKey(privateKey) };
}
