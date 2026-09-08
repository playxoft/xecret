/**
 * AES-256-GCM for the client subtree, over raw key bytes.
 *
 * `crypto/aead.ts` operates on an imported `CryptoKey` and is the server
 * envelope's chokepoint. The client hierarchy derives its keys as raw bytes —
 * HKDF output, an unwrapped EDK, a sealed-box key — so this is a thin adapter:
 * import, call, discard.
 *
 * ## The IV, and the one entry point that accepts one
 *
 * Every IV here is 12 fresh CSPRNG bytes generated at encryption time. IV reuse
 * under one key breaks GCM completely — it leaks the XOR of the two plaintexts
 * and enables forgery — which is why `aead.ts` offers no way to supply one and
 * why **no exported client API takes an IV parameter**.
 *
 * {@link encryptGcmWithIv} is the single exception, and it exists for the test
 * vectors, which cannot be reproducible unless their randomness is pinned. It is
 * deliberately absent from `crypto/client/index.ts`, and `package.json` exposes
 * only that barrel as `@xecret/core/crypto/client`, so no consumer of the
 * package can reach it. That containment is the whole of the protection: a
 * vector suite that forced an IV parameter into the public API would have traded
 * the property it exists to check for the ability to check it.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §1.1.
 */

import { importAesKey, IV_LENGTH, open as openAead } from '../aead';
import { randomBytes, utf8Encode } from '../encoding';
import type { Bytes, SealedBytes } from '../types';

/**
 * INTERNAL — encrypts under a caller-supplied IV.
 *
 * Not exported from `index.ts`. See the module header for why that matters.
 */
export async function encryptGcmWithIv(
  keyBytes: Bytes,
  iv: Bytes,
  plaintext: Bytes,
  aad: string,
): Promise<SealedBytes> {
  if (iv.length !== IV_LENGTH) {
    throw new TypeError(`AES-GCM requires a ${IV_LENGTH}-byte IV`);
  }

  const key = await importAesKey(keyBytes, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8Encode(aad), tagLength: 128 },
    key,
    plaintext,
  );

  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/** Encrypts under a fresh random IV. The only form production code calls. */
export async function encryptGcm(
  keyBytes: Bytes,
  plaintext: Bytes,
  aad: string,
): Promise<SealedBytes> {
  return encryptGcmWithIv(keyBytes, randomBytes(IV_LENGTH), plaintext, aad);
}

/**
 * Decrypts and verifies. Throws `DecryptionError` on any failure.
 *
 * Wrong key, wrong AAD, truncated ciphertext, flipped bit and forged tag are
 * indistinguishable to the caller — `aead.open` guarantees that, and this adds
 * nothing that could distinguish them.
 */
export async function decryptGcm(
  keyBytes: Bytes,
  sealed: SealedBytes,
  aad: string,
): Promise<Bytes> {
  const key = await importAesKey(keyBytes, ['decrypt']);
  return openAead(key, sealed, utf8Encode(aad));
}
