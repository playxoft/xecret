/**
 * The client half of the zero-knowledge vault.
 *
 * Everything that touches a key in the browser lives under this directory, and
 * this barrel is the only way in. Two things are deliberately absent from it:
 *
 * - `argon2-worker.ts`, which is a worker entry point rather than a module —
 *   importing it from application code would evaluate it on the main thread.
 * - The wrap and derive primitives. They are `@xecret/core/crypto/client`'s, and
 *   a screen reaching for one directly would be a screen composing cryptography,
 *   which `vault-client.ts` exists to stop happening in more than one place.
 */

export { VaultSetup } from './vault-setup';
export type { VaultSetupProps } from './vault-setup';

export { VaultUnlock } from './vault-unlock';
export type { Stage as VaultUnlockStage, VaultUnlockProps } from './vault-unlock';

export { VaultCard } from './vault-card';
export type { VaultCardProps } from './vault-card';

export { PasskeyEnrolment } from './passkey-enrolment';
export type { PasskeyEnrolmentProps } from './passkey-enrolment';

export { RecoveryKitPanel } from './recovery-kit-panel';
export type { RecoveryKitPanelProps } from './recovery-kit-panel';

export { useVault, useVaultKeys, VaultProvider } from './vault-keys';
export type { VaultContextValue } from './vault-keys';

export {
  readVaultKeys,
  releaseVaultKeys,
  restoreVaultKeys,
  subscribeVaultKeys,
  vaultKeysHeld,
} from './key-store';
export type { VaultKeyMaterial } from './key-store';

export { fetchVault, lockVault, setAutoLockMinutes } from './vault-client';
export type { VaultMaterial, VaultPasskey, VaultStatus } from './vault-client';
