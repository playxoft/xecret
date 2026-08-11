export { envKeyAad, orgKeyAad, secretAad } from './aad';
export { importAesKey, IV_LENGTH, KEY_LENGTH, open, seal } from './aead';
export {
  concatBytes,
  fromBase64Url,
  randomBytes,
  timingSafeEqual,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  zeroize,
} from './encoding';
export { EnvelopeService } from './envelope-service';
export {
  decodeShare,
  encodeShare,
  EscrowFormatError,
  EscrowVerificationError,
  fingerprint,
  recoverKeyFromShares,
  SHARE_PREFIX,
  splitKeyIntoShares,
} from './escrow';
export type { DecodedShare } from './escrow';
export {
  InMemoryKeyProvider,
  InvalidRootKeyMaterialError,
  keyProviderFromEnv,
  keyProviderFromSecretsStore,
  parseRootKeyMaterial,
} from './key-provider';
export type { RootKeyMaterial, SecretsStoreBinding } from './key-provider';
export {
  generateKeyBytes,
  rewrapOrgKey,
  unwrapEnvKey,
  unwrapOrgKey,
  wrapEnvKey,
  wrapOrgKey,
} from './keys';
export {
  computeValueHmac,
  decryptSecretValue,
  encryptSecretValue,
  MAX_SECRET_VALUE_BYTES,
  SecretTooLargeError,
} from './secrets';
export { DEFAULT_ALGORITHM, DecryptionError, UnknownKeyVersionError } from './types';
export { combine as combineShares, split as splitSecret } from './shamir';
export type { ShamirShare } from './shamir';
export type {
  Bytes,
  CipherAlgorithm,
  EncryptedValue,
  EncryptionContext,
  KeyProvider,
  SealedBytes,
  WrappedKey,
  WrappedOrgKey,
} from './types';
