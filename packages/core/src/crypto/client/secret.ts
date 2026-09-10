/**
 * Secret values and notes, encrypted on the client under the Environment Data
 * Key — and the keyed tag that lets the server detect a no-op write without
 * seeing either.
 *
 * This is the module that makes the claim true. After cutover the server
 * receives an `xk2.gcm.` string and a 32-byte tag, validates their shape, size,
 * and the caller's authorization, and stores them. It never holds a key that
 * opens them.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §2.2 types 9–10, §4, §9.
 */

import { secretNoteAad, secretValueAad } from '../aad';
import { IV_LENGTH } from '../aead';
import { utf8Decode } from '../encoding';
import { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
import type { Bytes, EncryptionContext } from '../types';
import { BlobFormatError, formatGcmBlob, parseGcmBlob } from './blob';
import { normalizedUtf8 } from './bytes';
import { decryptGcm, encryptGcm } from './gcm';
import { deriveKey, HKDF_INFO } from './hkdf';

const GCM_TAG_BYTES = 16;
const BLOB_PREFIX_CHARS = 'xk2.gcm.'.length;

/**
 * The ciphertext bound the server enforces.
 *
 * `MAX_SECRET_VALUE_BYTES` applies to the *plaintext* on the client — a client
 * MUST refuse an oversized value before encrypting it, which
 * {@link encryptSecretValue} does. The server can no longer see the plaintext,
 * so it needs the corresponding bound on what it does see: the blob string. This
 * is exactly that number — prefix, IV, tag, and base64url expansion — rather
 * than a round figure someone picked, so the two limits cannot drift apart.
 */
export const MAX_SECRET_BLOB_LENGTH =
  BLOB_PREFIX_CHARS + Math.ceil((IV_LENGTH + MAX_SECRET_VALUE_BYTES + GCM_TAG_BYTES) / 3) * 4;

/** Which field of a secret a ciphertext holds. Each has its own AAD purpose. */
export type SecretField = 'value' | 'note';

/**
 * The row a ciphertext belongs to.
 *
 * A note carries no version: notes live on the `secrets` row, not on the
 * append-only `secret_versions` row.
 */
export type SecretContext =
  | ({ field: 'value' } & EncryptionContext)
  | { field: 'note'; orgId: string; environmentId: string; secretId: string };

function secretAadFor(context: SecretContext): string {
  return context.field === 'note'
    ? secretNoteAad({
        orgId: context.orgId,
        environmentId: context.environmentId,
        secretId: context.secretId,
      })
    : secretValueAad({
        orgId: context.orgId,
        environmentId: context.environmentId,
        secretId: context.secretId,
        version: context.version,
      });
}

/**
 * Encrypts a secret value or note under the EDK.
 *
 * The plaintext is NFC-normalised, as every text input to this system is: the
 * same value typed on two platforms must produce the same `valueHmac`, or a
 * no-op write is recorded as a change on every save from the other machine.
 */
export async function encryptSecret(params: {
  edk: Bytes;
  context: SecretContext;
  plaintext: string;
}): Promise<string> {
  const plaintextBytes = normalizedUtf8(params.plaintext);

  if (plaintextBytes.length > MAX_SECRET_VALUE_BYTES) {
    throw new SecretTooLargeError(plaintextBytes.length);
  }

  try {
    return formatGcmBlob(
      await encryptGcm(params.edk, plaintextBytes, secretAadFor(params.context)),
    );
  } finally {
    plaintextBytes.fill(0);
  }
}

/**
 * Decrypts a secret value or note.
 *
 * Throws `DecryptionError` if the ciphertext was tampered with, if the EDK is
 * the wrong one — including the right environment's *previous* EDK, after a
 * rotation — or if the context does not match the one used at encryption time.
 * That last case is what stops a ciphertext row being relocated into an
 * environment the caller is allowed to read.
 *
 * Throws `BlobFormatError` for the one failure that is neither: a plaintext that
 * authenticated and is still not UTF-8. That is a `BlobFormatError` and not a
 * `DecryptionError` because the tag verified, so the key *was* right and the
 * bytes are exactly what the writer sealed — reporting it as a decryption
 * failure would send a user to re-enter a passphrase that has nothing wrong with
 * it. The alternative the platform offers is worse than either: a lenient
 * `TextDecoder` substitutes U+FFFD and returns mojibake, which the next save
 * writes back over the real value.
 */
export async function decryptSecret(params: {
  edk: Bytes;
  context: SecretContext;
  blob: string;
}): Promise<string> {
  const plaintextBytes = await decryptGcm(
    params.edk,
    parseGcmBlob(params.blob),
    secretAadFor(params.context),
  );

  try {
    return utf8Decode(plaintextBytes);
  } catch {
    // `utf8Decode` is already fatal, so this only re-labels what it threw: a
    // bare `TypeError` says nothing about which layer refused, and the caller
    // distinguishes the classes rather than the constructors. Nothing about the
    // plaintext is carried into the message — it is the secret.
    throw new BlobFormatError('Secret plaintext is not valid UTF-8');
  } finally {
    plaintextBytes.fill(0);
  }
}

/**
 * The change-detection tag, keyed from the Environment HMAC Key.
 *
 * **Keyed, not a bare digest.** A plain `SHA-256(plaintext)` would be an offline
 * brute-force oracle: most secrets are structured or low-entropy enough — short
 * API keys, connection strings with dictionary passwords — that an attacker
 * holding a database dump could confirm guesses at high speed. Keying it makes
 * the tag useless without the key hierarchy while still answering *"is this the
 * same value?"* server-side.
 *
 * **Keyed from the EHK, not the EDK.** This is the entire reason the EHK exists.
 * The EDK rotates whenever a principal is revoked; if the HMAC key rotated with
 * it, the first write to every secret after a rotation would be recorded as a
 * change when nothing changed.
 *
 * **No `environmentId` in the info string**, unlike the v1 derivation. The EHK
 * is already a per-environment random key, so two environments derive unrelated
 * HMAC keys; binding the id as well would add a component two implementations
 * could disagree about for a property that is already guaranteed.
 */
export async function computeValueHmac(params: { ehk: Bytes; plaintext: string }): Promise<Bytes> {
  const keyBytes = await deriveKey({ ikm: params.ehk, info: HKDF_INFO.valueHmac });
  const plaintextBytes = normalizedUtf8(params.plaintext);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, plaintextBytes));
  } finally {
    keyBytes.fill(0);
    plaintextBytes.fill(0);
  }
}
