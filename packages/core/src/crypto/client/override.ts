/**
 * Personal overrides (P19 §2): one value, replaced on one person's machine,
 * without touching the environment everybody else reads.
 *
 * An `xk2.gcm.` blob (spec §2.2 type 13) under the owner's **override key** —
 * HKDF-SHA256 of their own X25519 private key, info `xecret.v2.override-key` —
 * with an AAD naming the organisation, the environment, the owner and the name.
 *
 * ── Why a key only the owner can derive, and not a sealed box ──
 * The first construction sealed the value to the owner's public key. That gave
 * confidentiality and nothing else: a sealed box proves who it is *for*, never
 * who made it, and the owner's public key is published. Anybody holding it — the
 * server included — could have made an override the owner's own CLI would open
 * and inject into a process: `NODE_OPTIONS`, a different `DATABASE_URL`. For a
 * product whose premise is that the server cannot change what a member's
 * machine runs, that is the wrong property to give up, and it was given up for
 * nothing — the only party that ever needs to *write* an override is the party
 * that reads it.
 *
 * So the key is symmetric and derived from a secret only the owner holds. GCM's
 * tag is then a proof that the owner's own key made this blob, for this row:
 *
 *  - **Nobody else can open it.** Not a teammate holding the environment's key,
 *    not a service token, not the server. "Never visible to another member" is a
 *    property of the ciphertext, not only of the route that refuses to serve it.
 *  - **Nobody else can make one.** A blob the server fabricated, or moved from
 *    another row, fails the tag exactly as a tampered one does.
 *  - **A rotation never touches it.** It is under none of the environment's keys.
 *
 * The cost, stated where it is paid: a vault reset gives the account a new
 * keypair, and every override made under the old one stops opening. The CLI says
 * so and names the command that removes them — an override is a local
 * convenience, and losing one costs the minute it takes to set it again.
 */

import { overrideValueAad } from '../aad';
import { utf8Decode } from '../encoding';
import { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
import type { Bytes } from '../types';
import { BlobFormatError, formatGcmBlob, parseGcmBlob } from './blob';
import { normalizedUtf8 } from './bytes';
import { decryptGcm, encryptGcm } from './gcm';
import { deriveKey, HKDF_INFO } from './hkdf';
import { MAX_SECRET_BLOB_LENGTH } from './secret';

/** The longest override blob a conforming client can produce: a secret value's bound. */
export const MAX_OVERRIDE_BLOB_LENGTH = MAX_SECRET_BLOB_LENGTH;

/** The row an override belongs to — its unique key. */
export interface OverrideContext {
  orgId: string;
  environmentId: string;
  userId: string;
  name: string;
}

/**
 * The owner's override key. Exported for the vectors and the CLI's parity
 * tests; it is never stored and never leaves the process that derived it.
 */
export async function deriveOverrideKey(ownerPrivateKey: Bytes): Promise<Bytes> {
  return deriveKey({ ikm: ownerPrivateKey, info: HKDF_INFO.overrideKey });
}

/** Encrypts a value under its owner's override key. */
export async function sealOverrideValue(params: {
  ownerPrivateKey: Bytes;
  context: OverrideContext;
  value: string;
}): Promise<string> {
  const plaintext = normalizedUtf8(params.value);
  if (plaintext.length > MAX_SECRET_VALUE_BYTES) throw new SecretTooLargeError(plaintext.length);

  const key = await deriveOverrideKey(params.ownerPrivateKey);
  try {
    return formatGcmBlob(await encryptGcm(key, plaintext, overrideValueAad(params.context)));
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Opens an override with its owner's private key.
 *
 * `DecryptionError` for a blob that is not this person's, not this row's, was
 * made under a keypair a vault reset has since replaced, or was made by anybody
 * else at all — indistinguishable on purpose. `BlobFormatError` for a plaintext
 * that authenticated and is not UTF-8.
 */
export async function openOverrideValue(params: {
  ownerPrivateKey: Bytes;
  context: OverrideContext;
  blob: string;
}): Promise<string> {
  const key = await deriveOverrideKey(params.ownerPrivateKey);
  let plaintext: Bytes;
  try {
    plaintext = await decryptGcm(key, parseGcmBlob(params.blob), overrideValueAad(params.context));
  } finally {
    key.fill(0);
  }

  try {
    return utf8Decode(plaintext);
  } catch {
    throw new BlobFormatError('Override plaintext is not valid UTF-8');
  } finally {
    plaintext.fill(0);
  }
}
