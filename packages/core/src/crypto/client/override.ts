/**
 * Personal overrides (P19 §2): one value, replaced on one person's machine,
 * without touching the environment everybody else reads.
 *
 * Sealed to the owner's **own** X25519 public key (spec §2.2 type 13), with an
 * AAD naming the organisation, the environment, the owner and the name. Three
 * properties follow from that choice and are the reason for it:
 *
 *  - **No teammate can open it.** It is not under the environment's key, so
 *    holding the EDK — which every reader of the environment does — opens
 *    nothing here. "Never visible to another member" is a property of the
 *    ciphertext, not only of the route that refuses to serve it.
 *  - **A rotation never touches it.** An EDK rotation re-seals the environment's
 *    key to its principals; an override is under none of those keys.
 *  - **No service token can open it**, whatever a server served it, because a
 *    token has its own keypair and this is sealed to a person's.
 *
 * The cost, stated where it is paid: a vault reset gives the account a new
 * keypair, and every override sealed to the old one stops opening. The CLI says
 * so and offers to delete them — an override is a local convenience, and losing
 * one costs the minute it takes to set it again.
 */

import { overrideValueAad } from '../aad';
import { IV_LENGTH } from '../aead';
import { utf8Decode } from '../encoding';
import { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
import type { Bytes } from '../types';
import { BlobFormatError } from './blob';
import { normalizedUtf8 } from './bytes';
import { PUBLIC_KEY_BYTES } from './keypair';
import { openSealedBox, sealToPublicKey } from './sealed-box';

const GCM_TAG_BYTES = 16;
const BLOB_PREFIX_CHARS = 'xk2.x25519.'.length;

/** The longest override blob a conforming client can produce. Derived, like the secret bound. */
export const MAX_OVERRIDE_BLOB_LENGTH =
  BLOB_PREFIX_CHARS +
  Math.ceil((PUBLIC_KEY_BYTES + IV_LENGTH + MAX_SECRET_VALUE_BYTES + GCM_TAG_BYTES) / 3) * 4;

/** The row an override belongs to — its unique key. */
export interface OverrideContext {
  orgId: string;
  environmentId: string;
  userId: string;
  name: string;
}

/** Seals a value to its owner's own public key. */
export async function sealOverrideValue(params: {
  ownerPublicKey: Bytes;
  context: OverrideContext;
  value: string;
}): Promise<string> {
  const plaintext = normalizedUtf8(params.value);
  if (plaintext.length > MAX_SECRET_VALUE_BYTES) throw new SecretTooLargeError(plaintext.length);

  try {
    return await sealToPublicKey({
      recipientPublicKey: params.ownerPublicKey,
      plaintext,
      aad: overrideValueAad(params.context),
    });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Opens an override with its owner's private key.
 *
 * `DecryptionError` for a box that is not this person's, not this row's, or was
 * sealed to a keypair a vault reset has since replaced — indistinguishable on
 * purpose. `BlobFormatError` for a plaintext that authenticated and is not UTF-8.
 */
export async function openOverrideValue(params: {
  ownerPrivateKey: Bytes;
  context: OverrideContext;
  blob: string;
}): Promise<string> {
  const plaintext = await openSealedBox({
    recipientPrivateKey: params.ownerPrivateKey,
    blob: params.blob,
    aad: overrideValueAad(params.context),
  });

  try {
    return utf8Decode(plaintext);
  } catch {
    throw new BlobFormatError('Override plaintext is not valid UTF-8');
  } finally {
    plaintext.fill(0);
  }
}
