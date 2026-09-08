/**
 * Everything that wraps a key in another key.
 *
 * Two shapes live here, because they are the same operation seen from the two
 * ends of the hierarchy:
 *
 * - **User Key wraps** (blob types 1–5). Symmetric, under a key derived from
 *   something the user has: a passphrase, a recovery code, a passkey's PRF
 *   output. The wrapped thing is the 32-byte User Key, or a private key under
 *   the User Key.
 * - **Grant seals** (blob types 6–7). Asymmetric, to a principal's X25519 public
 *   key. The wrapped thing is an Environment Data Key or an Environment HMAC
 *   Key, and the principal may be a member, a service token, or an invitation.
 *
 * ## Why the UK is wrapped, rather than being derived
 *
 * Changing a passphrase re-wraps one 32-byte key. Nothing else re-encrypts, no
 * secret is touched, and sessions on other devices stay valid because the User
 * Key itself never changed. Deriving the UK from the passphrase instead would
 * make a passphrase change a re-encryption of everything the user can reach.
 *
 * ## Why every wrap carries AAD
 *
 * All five recovery wraps hold the same User Key. Without a discriminator in the
 * AAD, swapping two rows in the database would be undetectable; with one, a
 * swapped row fails to open. The same reasoning binds each private key to its
 * purpose, so the X25519 blob cannot be presented where the Ed25519 blob belongs.
 *
 * Spec: docs/security/e2ee-crypto-spec.md §2.2, §3.3, §5.
 */

import {
  edkGrantAad,
  ehkGrantAad,
  privateKeyEncAad,
  privateKeySignAad,
  userKeyWrapAad,
} from '../aad';
import type { RecipientKind } from '../aad';
import { KEY_LENGTH } from '../aead';
import { randomBytes } from '../encoding';
import type { Bytes } from '../types';
import { formatGcmBlob, parseGcmBlob } from './blob';
import { toHex } from './bytes';
import { decryptGcm, encryptGcm } from './gcm';
import { deriveKey, HKDF_INFO } from './hkdf';
import { openSealedBox, sealToPublicKey } from './sealed-box';

/** A fresh 32-byte User Key. Wrapped several times, derived never. */
export function generateUserKey(): Bytes {
  return randomBytes(KEY_LENGTH);
}

/** A fresh Environment Data Key. Replaced on every rotation. */
export function generateEnvironmentDataKey(): Bytes {
  return randomBytes(KEY_LENGTH);
}

/** A fresh Environment HMAC Key. Long-lived; survives EDK rotation by design. */
export function generateEnvironmentHmacKey(): Bytes {
  return randomBytes(KEY_LENGTH);
}

/**
 * `SK` → the key that wraps the User Key in the passphrase wrap.
 *
 * Never wrap with the raw Stretched Key. `SK` has two sibling branches — this
 * and the unlock verifier — and the verifier is handed to the server. If the
 * wrap key were `SK` itself, or anything invertibly derived from the verifier, a
 * server holding verifiers would hold wrap keys.
 */
export async function derivePassphraseWrapKey(stretchedKey: Bytes): Promise<Bytes> {
  return deriveKey({ ikm: stretchedKey, info: HKDF_INFO.ukWrap });
}

/**
 * `SK` → the value the server stores the SHA-256 of.
 *
 * Possessing it opens no vault. Unlock is a client-side question — *can I unwrap
 * the User Key?* — and the answer never leaves the browser. The verifier exists
 * so the server can maintain `vaultUnlockedAt`, apply the unlock backoff, and
 * keep an audit trail.
 */
export async function deriveUnlockVerifier(stretchedKey: Bytes): Promise<Bytes> {
  return deriveKey({ ikm: stretchedKey, info: HKDF_INFO.unlockVerifier });
}

/** A WebAuthn PRF output → the passkey wrap key. */
export async function derivePasskeyWrapKey(prfOutput: Bytes): Promise<Bytes> {
  return deriveKey({ ikm: prfOutput, info: HKDF_INFO.prfWrap });
}

/**
 * Which wrap this is, and the discriminator that binds it to its own row.
 *
 * `lookupHash` is the recovery code's server-side lookup value; it appears in
 * the AAD as lowercase hex, which is also how it is stored.
 */
export type UserKeyWrapContext =
  | { userId: string; wrapKind: 'passphrase' }
  | { userId: string; wrapKind: 'recovery'; lookupHash: Bytes }
  | { userId: string; wrapKind: 'prf'; credentialIdB64Url: string };

function wrapAad(context: UserKeyWrapContext): string {
  switch (context.wrapKind) {
    case 'recovery':
      return userKeyWrapAad({
        userId: context.userId,
        wrapKind: 'recovery',
        lookupHashHex: toHex(context.lookupHash),
      });
    case 'prf':
      return userKeyWrapAad({
        userId: context.userId,
        wrapKind: 'prf',
        credentialIdB64Url: context.credentialIdB64Url,
      });
    default:
      return userKeyWrapAad({ userId: context.userId, wrapKind: 'passphrase' });
  }
}

/** Wraps the User Key under one of its wrap keys. Returns an `xk2.gcm.` blob. */
export async function wrapUserKey(params: {
  wrapKey: Bytes;
  userKey: Bytes;
  context: UserKeyWrapContext;
}): Promise<string> {
  if (params.userKey.length !== KEY_LENGTH) {
    throw new TypeError(`The User Key is ${KEY_LENGTH} bytes`);
  }

  return formatGcmBlob(await encryptGcm(params.wrapKey, params.userKey, wrapAad(params.context)));
}

/**
 * Unwraps the User Key. Throws `DecryptionError` on any failure.
 *
 * A wrong passphrase, a wrong recovery code, a wrap row swapped with another
 * user's, and a tampered blob are one indistinguishable outcome here. The caller
 * that needs to tell "wrong passphrase" from "corrupt record" cannot, and should
 * not: the honest message is that the vault did not open.
 */
export async function unwrapUserKey(params: {
  wrapKey: Bytes;
  blob: string;
  context: UserKeyWrapContext;
}): Promise<Bytes> {
  return decryptGcm(params.wrapKey, parseGcmBlob(params.blob), wrapAad(params.context));
}

/** Which private key a `privkey` blob holds. Bound into its AAD. */
export type PrivateKeyPurpose = 'encryption' | 'signing';

function privateKeyAad(userId: string, purpose: PrivateKeyPurpose): string {
  return purpose === 'signing' ? privateKeySignAad(userId) : privateKeyEncAad(userId);
}

/**
 * Wraps a 32-byte private key under the User Key.
 *
 * The Ed25519 key is stored as its **seed**, not its 64-byte expanded form: the
 * seed is what the signature API takes, and storing the expansion would be
 * storing a derived value that a future library version might expand differently.
 */
export async function wrapPrivateKey(params: {
  userKey: Bytes;
  privateKey: Bytes;
  userId: string;
  purpose: PrivateKeyPurpose;
}): Promise<string> {
  if (params.privateKey.length !== KEY_LENGTH) {
    throw new TypeError('A private key is 32 bytes');
  }

  return formatGcmBlob(
    await encryptGcm(
      params.userKey,
      params.privateKey,
      privateKeyAad(params.userId, params.purpose),
    ),
  );
}

/** Unwraps a private key. Throws `DecryptionError` on any failure. */
export async function unwrapPrivateKey(params: {
  userKey: Bytes;
  blob: string;
  userId: string;
  purpose: PrivateKeyPurpose;
}): Promise<Bytes> {
  return decryptGcm(
    params.userKey,
    parseGcmBlob(params.blob),
    privateKeyAad(params.userId, params.purpose),
  );
}

/**
 * The principal a grant is for.
 *
 * One shape for all three kinds, because it *is* one operation: a member, a
 * service token, and an invitation each own an X25519 keypair, and the only
 * difference between them is two AAD components. Rotation re-seals to every
 * remaining principal without caring which is which — which is why a service
 * token survives an EDK rotation.
 */
export interface GrantRecipient {
  environmentId: string;
  edkVersion: number;
  recipientKind: RecipientKind;
  recipientId: string;
  recipientPublicKey: Bytes;
}

/** The two sealed blobs one `env_key_grants` row holds. */
export interface SealedGrant {
  edkSealed: string;
  ehkSealed: string;
}

/**
 * Seals an EDK and an EHK to one principal.
 *
 * Two calls, not one: each gets its own ephemeral keypair, its own IV, and its
 * own AAD. They are stored in separate columns because the EHK is re-sealed
 * unchanged across an EDK rotation while the EDK is replaced — sealing them as
 * one pair would force the EHK to be re-encrypted for a reason that has nothing
 * to do with it.
 */
export async function sealGrant(params: {
  recipient: GrantRecipient;
  edk: Bytes;
  ehk: Bytes;
}): Promise<SealedGrant> {
  const { recipient } = params;

  if (params.edk.length !== KEY_LENGTH || params.ehk.length !== KEY_LENGTH) {
    throw new TypeError(`An environment key is ${KEY_LENGTH} bytes`);
  }

  const edkSealed = await sealToPublicKey({
    recipientPublicKey: recipient.recipientPublicKey,
    plaintext: params.edk,
    aad: edkGrantAad({
      environmentId: recipient.environmentId,
      edkVersion: recipient.edkVersion,
      recipientKind: recipient.recipientKind,
      recipientId: recipient.recipientId,
    }),
  });

  const ehkSealed = await sealToPublicKey({
    recipientPublicKey: recipient.recipientPublicKey,
    plaintext: params.ehk,
    aad: ehkGrantAad({
      environmentId: recipient.environmentId,
      recipientKind: recipient.recipientKind,
      recipientId: recipient.recipientId,
    }),
  });

  return { edkSealed, ehkSealed };
}

/** Opens a grant with the recipient's private key. */
export async function openGrant(params: {
  recipient: Omit<GrantRecipient, 'recipientPublicKey'>;
  recipientPrivateKey: Bytes;
  grant: SealedGrant;
}): Promise<{ edk: Bytes; ehk: Bytes }> {
  const { recipient } = params;

  const edk = await openSealedBox({
    recipientPrivateKey: params.recipientPrivateKey,
    blob: params.grant.edkSealed,
    aad: edkGrantAad({
      environmentId: recipient.environmentId,
      edkVersion: recipient.edkVersion,
      recipientKind: recipient.recipientKind,
      recipientId: recipient.recipientId,
    }),
  });

  const ehk = await openSealedBox({
    recipientPrivateKey: params.recipientPrivateKey,
    blob: params.grant.ehkSealed,
    aad: ehkGrantAad({
      environmentId: recipient.environmentId,
      recipientKind: recipient.recipientKind,
      recipientId: recipient.recipientId,
    }),
  });

  return { edk, ehk };
}
