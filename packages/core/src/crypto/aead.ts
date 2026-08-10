import { DecryptionError } from './types';
import type { SealedBytes } from './types';
import { randomBytes } from './encoding';
import type { Bytes } from './types';

/**
 * Authenticated encryption, AES-256-GCM.
 *
 * This is the only place in xecret that calls `crypto.subtle.encrypt` or
 * `crypto.subtle.decrypt`. Everything above it — key wrapping, secret storage —
 * is expressed in terms of `seal` and `open`, so there is exactly one place to
 * review for correct IV handling and tag verification.
 */

/** 96 bits — the size AES-GCM is specified and optimised for. */
export const IV_LENGTH = 12;

/** 256 bits. */
export const KEY_LENGTH = 32;

/** 128-bit authentication tag; Web Crypto appends it to the ciphertext. */
const TAG_LENGTH_BITS = 128;

/**
 * Imports raw key bytes as an AES-GCM key.
 *
 * `extractable: false` means the key cannot be read back out via
 * `crypto.subtle.exportKey`. It narrows what an attacker with code execution in
 * the Worker can walk away with (threat T7) — it does not stop them using the
 * key while they are there.
 */
export async function importAesKey(
  keyBytes: Bytes,
  usages: readonly KeyUsage[] = ['encrypt', 'decrypt'],
): Promise<CryptoKey> {
  if (keyBytes.length !== KEY_LENGTH) {
    throw new TypeError(`AES-256 requires a ${KEY_LENGTH}-byte key, received ${keyBytes.length}`);
  }

  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [...usages]);
}

/**
 * Encrypts `plaintext` under `key`, authenticating `aad`.
 *
 * A fresh random IV is generated for every call and never reused. IV reuse under
 * the same key is catastrophic for GCM — it leaks the XOR of the two plaintexts
 * and allows forgery — so the IV is generated here rather than accepted as a
 * parameter. There is deliberately no way for a caller to supply one.
 */
export async function seal(key: CryptoKey, plaintext: Bytes, aad: Bytes): Promise<SealedBytes> {
  const iv = randomBytes(IV_LENGTH);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
    key,
    plaintext,
  );

  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/**
 * Decrypts and verifies. Throws {@link DecryptionError} on any failure.
 *
 * All failure modes — wrong key, wrong AAD, truncated ciphertext, flipped bit,
 * forged tag — surface as the same error with the same message. Distinguishing
 * them would tell an attacker probing the API which part of their guess was
 * wrong, and there is no legitimate caller that needs to know.
 */
export async function open(key: CryptoKey, sealed: SealedBytes, aad: Bytes): Promise<Bytes> {
  if (sealed.iv.length !== IV_LENGTH) {
    throw new DecryptionError();
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
      key,
      sealed.ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    // The underlying OperationError is swallowed on purpose — it must not reach
    // a log or an API response.
    throw new DecryptionError();
  }
}
