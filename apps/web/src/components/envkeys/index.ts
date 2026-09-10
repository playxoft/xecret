/**
 * The client half of the environment key hierarchy.
 *
 * `components/vault` holds the *user* half — the User Key, the two private keys,
 * the unlock ceremonies. This holds what those keys reach: the Environment Data
 * Key and the Environment HMAC Key of each environment, the grants that carry
 * them between principals, and every secret value encrypted under them.
 *
 * This barrel is the only way in, for the reason the vault's says: a screen
 * reaching for `sealGrant` or `encryptSecret` directly would be a screen
 * composing cryptography, and `env-keys.ts` and `secret-crypto.ts` exist so that
 * happens in exactly one place. Two things are deliberately absent:
 *
 * - The store's `holdEnvKey` and `releaseEnvironment`. Key material enters
 *   through `openEnvironmentKeys` and leaves when the vault locks; a caller
 *   putting bytes into the store by hand would be a second way in.
 * - `RotatedAwayError`'s siblings — there are none. Every other failure is a
 *   `DecryptionError` from core, and callers that catch by type would be
 *   catching a distinction the crypto layer refuses to make.
 */

export { EnvKeyUnavailableState, NeedsRotationBanner } from './env-key-notice';

export { EnvironmentKeyCard } from './environment-key-card';

export {
  createEnvironmentKeys,
  decodeRecipientKey,
  fetchEnvironmentKeys,
  fetchRecipients,
  grantsPath,
  invitePublicKey,
  keysPath,
  openEnvironmentKeys,
  readRetiredKey,
  recipientsPath,
  reSealInviteGrants,
  rotatePath,
  sealGrantFor,
  sealInviteGrant,
} from './env-keys';
export type { EnvironmentRef, EnvKeyUnavailable, OpenEnvironmentResult } from './env-keys';

export { envKeyCount, releaseEnvKeys, subscribeEnvKeys } from './env-key-store';
export type { EnvKeyMaterial } from './env-key-store';

export { FingerprintList, KeyFingerprint } from './fingerprint-badge';

export { MemberKeyBadge } from './member-key-badge';

export { InviteKeyStep } from './invite-key-step';
export type { InviteKeyStepProps } from './invite-key-step';

export { PendingSharesBanner } from './pending-shares';

export {
  checkPin,
  fingerprint,
  modeIsAllowed,
  modePinKey,
  pinKey,
  readModePins,
  readPins,
  recordModePin,
  recordPin,
  replacePin,
  writePins,
} from './pins';
export type {
  EncryptionMode,
  ModePin,
  ModePinStore,
  Pin,
  PinCheck,
  PinnedKind,
  PinStore,
} from './pins';

export { RotationDialog } from './rotation-dialog';

export {
  buildRotationGrants,
  completenessProblems,
  nextEdkVersion,
  planRotation,
  rotateEnvironment,
  shareTargets,
} from './rotation';
export type { RotationOutcome, RotationPlan } from './rotation';

export {
  CLIENT_ALGORITHM,
  decryptNote,
  decryptValue,
  encodeNote,
  encryptNote,
  encryptValue,
} from './secret-crypto';
export type { SecretTarget } from './secret-crypto';

export { clientSecretIo, renderExport, RotatedAwayError, serverSecretIo } from './secret-io';
export type { MetadataPatch, SecretIo, SecretIoContext, SecretRef } from './secret-io';

export { ioOf, useEnvironmentKeys } from './use-environment-keys';
export type { EnvironmentKeyHandle, EnvironmentKeyState } from './use-environment-keys';

export type {
  ActiveEdk,
  ClientEnvironmentBundle,
  ClientSecretCiphertext,
  ClientValueBody,
  EnvironmentKeys,
  GrantBody,
  InviteKeyGrant,
  MyGrant,
  PendingGrant,
  Recipient,
  RecipientsResponse,
  Unsealable,
} from './types';
