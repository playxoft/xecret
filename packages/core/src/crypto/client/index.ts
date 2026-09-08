/**
 * Client-side (zero-knowledge) crypto primitives.
 *
 * This is the public surface of `@xecret/core/crypto/client`, and it is a
 * separate subpath from `@xecret/core/crypto` on purpose: importing these
 * primitives must not drag the server envelope — `KeyProvider`, the Secrets
 * Store binding types, `EnvelopeService` — into a browser bundle.
 *
 * Everything below runs unchanged in a browser, in a Worker, and under Node.
 * Named exports only, no module-scope side effects, so a bundler can drop what
 * an application does not use.
 *
 * Two kinds of thing are deliberately **absent** from this barrel:
 *
 * - The randomness-injecting entry points (`encryptGcmWithIv`,
 *   `sealToPublicKeyWithRandomness`). They exist so the test vectors can be
 *   reproducible; keeping them out of the barrel, and out of `package.json`'s
 *   `exports`, is what stops a caller ever supplying an IV. See `gcm.ts`.
 * - The vector builder under `vectors/`, which is test scaffolding.
 *
 * Spec: docs/security/e2ee-crypto-spec.md
 */

export {
  BLOB_ALGORITHMS,
  BLOB_VERSION,
  BlobFormatError,
  formatBlob,
  formatGcmBlob,
  parseBlob,
  parseGcmBlob,
} from './blob';
export type { BlobAlgorithm } from './blob';

export {
  assertLength,
  copyBytes,
  fromHex,
  lengthPrefixed,
  normalizedUtf8,
  normalizeText,
  toHex,
  u32be,
} from './bytes';

export { deriveKey, HKDF_INFO, HKDF_OUTPUT_BYTES, isRegisteredInfo } from './hkdf';
export type { HkdfInfo } from './hkdf';

export {
  ARGON2_VERSION,
  CURRENT_KDF_PARAMS,
  deriveStretchedKey,
  generateKdfSalt,
  KDF_SALT_BYTES,
  kdfNeedsUpgrade,
  KdfParamsError,
  nobleArgon2idProvider,
  parseKdfParams,
} from './kdf';
export type { Argon2idParams, Argon2idProvider } from './kdf';

export {
  decodePublicKey,
  deriveInviteKeyPair,
  encodePublicKey,
  encryptionPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  signingPublicKey,
} from './keypair';
export type { KeyPair } from './keypair';

export { openSealedBox, sealToPublicKey } from './sealed-box';

export {
  GRANT_SIGNATURE_DOMAIN,
  grantSigningPayload,
  signGrant,
  verifyGrantSignature,
} from './sign';
export type { GrantSignatureFields } from './sign';

export {
  CROCKFORD_ALPHABET,
  deriveRecoveryKey,
  encodeInviteFragment,
  encodeRecoveryCode,
  generateInviteFragment,
  generateRecoveryCode,
  generateRecoveryCodes,
  INVITE_FRAGMENT_DATA_CHARS,
  isValidLuhnMod32,
  luhnMod32,
  normalizeCrockford,
  parseInviteFragment,
  parseRecoveryCode,
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_DATA_CHARS,
  RecoveryCodeError,
  recoveryLookupHash,
} from './recovery';
export type { InviteFragment, RecoveryCode } from './recovery';

export {
  derivePasskeyWrapKey,
  derivePassphraseWrapKey,
  deriveUkUnlockVerifier,
  deriveUnlockVerifier,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateUserKey,
  openGrant,
  sealGrant,
  unwrapPrivateKey,
  unwrapUserKey,
  wrapPrivateKey,
  wrapUserKey,
} from './wraps';
export type { GrantRecipient, PrivateKeyPurpose, SealedGrant, UserKeyWrapContext } from './wraps';

export { computeValueHmac, decryptSecret, encryptSecret, MAX_SECRET_BLOB_LENGTH } from './secret';
export type { SecretContext, SecretField } from './secret';

/**
 * The three encoding helpers a client needs and cannot get from `./bytes`.
 *
 * They live in `../encoding`, which every module here already imports for
 * `randomBytes`, and which is plain Web Crypto with no server dependency — so
 * re-exporting them costs a browser bundle nothing. Naming them here rather than
 * letting a caller reach for `@xecret/core/crypto` is the point: that barrel
 * drags `EnvelopeService` and the Secrets Store binding types into the bundle,
 * which is the entire reason this subpath exists.
 *
 * `toBase64Url` and `fromBase64Url` are how every non-blob binary field in the
 * vault API travels — the salt, the verifier, the recovery lookup hash, a
 * WebAuthn credential id. `zeroize` is what a lock does to the User Key.
 */
export { fromBase64Url, toBase64Url, zeroize } from '../encoding';

/**
 * Re-exported from the shared crypto layer, so a client-only importer does not
 * need a second import path for the error every one of these functions throws.
 */
export { DecryptionError } from '../types';
export { MAX_SECRET_VALUE_BYTES, SecretTooLargeError } from '../secrets';
export type { Bytes } from '../types';

/** The v2 AAD builders, which the client is the only writer of. */
export {
  AAD_PREFIX_V2,
  edkGrantAad,
  ehkGrantAad,
  isAadV2,
  privateKeyEncAad,
  privateKeySignAad,
  secretNoteAad,
  secretValueAad,
  userKeyWrapAad,
} from '../aad';
export type { RecipientKind, WrapKind } from '../aad';
