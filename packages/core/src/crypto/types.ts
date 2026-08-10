/**
 * Envelope encryption types.
 *
 * Implementations land in Phase 2. These types are fixed now because the
 * database schema (packages/db) and the key ceremony
 * (docs/security/key-recovery.md) both depend on their shape.
 *
 * See docs/adr/0001-trust-model.md and docs/adr/0002-root-key-custody.md.
 */

/** Algorithms xecret is permitted to use. Never invent cryptography (Rule 3). */
export type CipherAlgorithm = 'AES-256-GCM';

/**
 * Supplies the Root Key Encryption Key.
 *
 * The v1 implementation reads it from a Cloudflare Secrets Store binding, whose
 * value originated in Phase.dev at deploy time. The Worker never fetches it over
 * the network at runtime — see ADR 0002 for the four reasons why.
 */
export interface KeyProvider {
  /**
   * Returns the Root KEK for a given version, as a **non-extractable** CryptoKey
   * so it cannot be trivially serialised out of Worker memory (threat T7).
   */
  getRootKey(version: number): Promise<CryptoKey>;

  /** The version new wrapping operations should use. */
  currentVersion(): number;
}

/**
 * Additional authenticated data bound to every ciphertext.
 *
 * Binding these fields means a ciphertext row copied into a different
 * environment or secret fails to decrypt rather than silently succeeding — an
 * attacker with database write access cannot relocate a production secret into
 * an environment they are allowed to read.
 */
export interface EncryptionContext {
  orgId: string;
  environmentId: string;
  secretId: string;
  version: number;
}

/** A wrapped key as stored in `org_keys` / `env_keys`. */
export interface WrappedKey {
  wrappedKey: Uint8Array;
  wrapIv: Uint8Array;
  algorithm: CipherAlgorithm;
  version: number;
}

/** A ciphertext as stored in `secret_versions`. */
export interface EncryptedValue {
  ciphertext: Uint8Array;
  /** 96-bit, unique per encryption operation. Reuse breaks AES-GCM entirely. */
  iv: Uint8Array;
  algorithm: CipherAlgorithm;
}

/** Raised when decryption fails. Deliberately carries no detail — see Rule 9. */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}
