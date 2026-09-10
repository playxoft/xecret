/**
 * The sealed box: anonymous public-key encryption of a 32-byte key.
 *
 *     ephemeral X25519 → ECDH → HKDF-SHA256 → AES-256-GCM
 *     payload = ephemeralPub(32) ‖ iv(12) ‖ ciphertext‖tag
 *
 * Used to seal the EDK and the EHK to a member, a service token, or an
 * invitation. It is anonymous: the recipient learns nothing about who sealed it
 * from the box itself. That is what the grant signature (`sign.ts`) is for.
 *
 * ## Three requirements that are easy to skip
 *
 * **The public keys go in the HKDF salt.** `HKDF(shared, "", info, 32)` would
 * derive the same key for any pair producing the same shared secret and would
 * leave the transmitted `ephemeralPub` outside the KDF's view. Binding
 * `ephemeralPub ‖ recipientPub` into the salt makes the derived key specific to
 * the exact pair — the property libsodium's `crypto_box_seal` gets by hashing
 * both keys into its nonce, and HPKE through its KEM context. The order is fixed
 * as ephemeral first, recipient second; reversing it produces a different,
 * non-interoperable key.
 *
 * **The AAD is used twice, deliberately** — as the HKDF `info` and as the GCM
 * `additionalData`. The first binds the *key* to the context, so a relocated
 * blob derives the wrong key; the second binds the *ciphertext*, so a relocated
 * blob also fails authentication. Either alone would do; both cost nothing and
 * mean an implementation that drops one still fails closed.
 *
 * **An all-zero shared secret is rejected.** X25519 returns all zeros for
 * low-order input points, and continuing past that would derive a key an
 * attacker chose. `@noble/curves` throws; this module does not catch and ignore
 * it, and checks the result itself as well so the requirement does not depend on
 * a library's error behaviour staying what it is today.
 *
 * **Ephemeral keys are single-use.** A fresh keypair per seal, never cached,
 * never reused across recipients or across the EDK and EHK of one grant.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §5.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { IV_LENGTH } from '../aead';
import { randomBytes } from '../encoding';
import { DecryptionError } from '../types';
import type { Bytes } from '../types';
import { copyBytes } from './bytes';
import { formatBlob, parseBlob } from './blob';
import { decryptGcm, encryptGcmWithIv } from './gcm';
import { deriveKey, isRegisteredInfo } from './hkdf';
import { encryptionPublicKey, PRIVATE_KEY_BYTES, PUBLIC_KEY_BYTES } from './keypair';

const EPHEMERAL_PUBLIC_KEY_OFFSET = PUBLIC_KEY_BYTES;
const IV_OFFSET = EPHEMERAL_PUBLIC_KEY_OFFSET + IV_LENGTH;

function assertNotZero(shared: Bytes): void {
  let difference = 0;
  for (const byte of shared) difference |= byte;
  if (difference === 0) {
    throw new TypeError('X25519 produced an all-zero shared secret');
  }
}

async function sealedBoxKey(
  shared: Bytes,
  ephemeralPublicKey: Bytes,
  recipientPublicKey: Bytes,
  aad: string,
): Promise<Bytes> {
  assertNotZero(shared);

  const salt = new Uint8Array(PUBLIC_KEY_BYTES * 2);
  salt.set(ephemeralPublicKey, 0);
  salt.set(recipientPublicKey, PUBLIC_KEY_BYTES);

  return deriveKey({ ikm: shared, salt, info: aad });
}

/**
 * INTERNAL — seals under a caller-supplied ephemeral key and IV.
 *
 * Absent from `index.ts` for the reason `gcm.ts` explains at length: the test
 * vectors cannot be reproducible unless their randomness is pinned, and the
 * exported {@link sealToPublicKey} must not be the thing that accepts it.
 */
export async function sealToPublicKeyWithRandomness(params: {
  recipientPublicKey: Bytes;
  plaintext: Bytes;
  aad: string;
  ephemeralPrivateKey: Bytes;
  iv: Bytes;
}): Promise<string> {
  if (params.recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new TypeError('recipient public key must be 32 bytes');
  }
  if (params.ephemeralPrivateKey.length !== PRIVATE_KEY_BYTES) {
    throw new TypeError('ephemeral private key must be 32 bytes');
  }

  const ephemeralPublicKey = encryptionPublicKey(params.ephemeralPrivateKey);
  const shared = copyBytes(
    x25519.getSharedSecret(params.ephemeralPrivateKey, params.recipientPublicKey),
  );

  let key: Bytes | undefined;
  try {
    key = await sealedBoxKey(shared, ephemeralPublicKey, params.recipientPublicKey, params.aad);
    const sealed = await encryptGcmWithIv(key, params.iv, params.plaintext, params.aad);

    const payload = new Uint8Array(PUBLIC_KEY_BYTES + sealed.iv.length + sealed.ciphertext.length);
    payload.set(ephemeralPublicKey, 0);
    payload.set(sealed.iv, EPHEMERAL_PUBLIC_KEY_OFFSET);
    payload.set(sealed.ciphertext, IV_OFFSET);

    return formatBlob('x25519', payload);
  } finally {
    shared.fill(0);
    key?.fill(0);
    // The ephemeral private key belongs to the caller in this internal form; the
    // exported entry point below generates and wipes its own.
  }
}

/**
 * Seals a plaintext — in practice a 32-byte EDK or EHK — to a public key.
 *
 * Takes no IV and no ephemeral key: both are generated here, per call, and
 * discarded. Returns an `xk2.x25519.` blob.
 */
export async function sealToPublicKey(params: {
  recipientPublicKey: Bytes;
  plaintext: Bytes;
  aad: string;
}): Promise<string> {
  const ephemeralPrivateKey = randomBytes(PRIVATE_KEY_BYTES);

  try {
    return await sealToPublicKeyWithRandomness({
      ...params,
      ephemeralPrivateKey,
      iv: randomBytes(IV_LENGTH),
    });
  } finally {
    ephemeralPrivateKey.fill(0);
  }
}

/**
 * Opens a sealed box.
 *
 * Every failure — wrong recipient, wrong AAD, truncated payload, flipped bit,
 * forged tag — surfaces as one indistinguishable `DecryptionError` carrying no
 * detail. Distinguishing them would tell an attacker probing the API which part
 * of their guess was wrong. A malformed *blob*, by contrast, is a
 * `BlobFormatError` from `blob.ts`: that is a fact about a string the attacker
 * already holds.
 */
export async function openSealedBox(params: {
  recipientPrivateKey: Bytes;
  blob: string;
  aad: string;
}): Promise<Bytes> {
  if (params.recipientPrivateKey.length !== PRIVATE_KEY_BYTES) {
    throw new TypeError('recipient private key must be 32 bytes');
  }

  // Checked before the uniform-failure block below, so that a caller passing a
  // string that is not an AAD at all gets told so, rather than a decryption
  // error it would spend an afternoon on.
  if (!isRegisteredInfo(params.aad)) {
    throw new TypeError('sealed box AAD is not a registered HKDF info string');
  }

  const payload = parseBlob(params.blob, 'x25519');
  const ephemeralPublicKey = payload.slice(0, EPHEMERAL_PUBLIC_KEY_OFFSET);
  const iv = payload.slice(EPHEMERAL_PUBLIC_KEY_OFFSET, IV_OFFSET);
  const ciphertext = payload.slice(IV_OFFSET);

  const recipientPublicKey = encryptionPublicKey(params.recipientPrivateKey);

  let shared: Bytes;
  try {
    shared = copyBytes(x25519.getSharedSecret(params.recipientPrivateKey, ephemeralPublicKey));
  } catch {
    // A low-order or otherwise degenerate ephemeral key in the blob. Reported as
    // a decryption failure like every other unopenable box: the caller's
    // situation is identical and the detail is only useful to an attacker.
    throw new DecryptionError();
  }

  let key: Bytes | undefined;
  try {
    key = await sealedBoxKey(shared, ephemeralPublicKey, recipientPublicKey, params.aad);
    return await decryptGcm(key, { iv, ciphertext }, params.aad);
  } catch (error) {
    throw error instanceof DecryptionError ? error : new DecryptionError();
  } finally {
    shared.fill(0);
    key?.fill(0);
  }
}
