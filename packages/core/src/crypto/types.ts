/**
 * Envelope encryption types.
 *
 * The hierarchy, and why it has three levels rather than one:
 *
 *   Root KEK          never in the database; from Cloudflare Secrets Store
 *     └─ wraps → Org Master Key      stored wrapped, in `org_keys`
 *          └─ wraps → Env Data Key   stored wrapped, in `env_keys`
 *               └─ encrypts → secret ciphertext, in `secret_versions`
 *
 * Each level can be rotated without touching the level below it. Rotating the
 * root re-wraps N org keys and never reads a secret. Deleting an env key makes
 * every secret in that environment permanently unreadable without rewriting a
 * single ciphertext row — that is how deletion is honoured when backups still
 * hold the data.
 *
 * See docs/adr/0001-trust-model.md and docs/adr/0002-root-key-custody.md.
 */

/**
 * Byte arrays backed by a real ArrayBuffer.
 *
 * TypeScript 5.7 made `Bytes` generic over its backing buffer, and Web
 * Crypto's `BufferSource` accepts only ArrayBuffer-backed views — not
 * SharedArrayBuffer ones. Naming the constraint once keeps every crypto
 * signature honest instead of scattering casts across the call sites.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Algorithms xecret is permitted to use. Never invent cryptography (Rule 2). */
export type CipherAlgorithm = 'AES-256-GCM';

export const DEFAULT_ALGORITHM: CipherAlgorithm = 'AES-256-GCM';

/**
 * Supplies the Root Key Encryption Key.
 *
 * The v1 implementation reads it from a Cloudflare Secrets Store binding whose
 * value originated in Phase.dev at deploy time. The Worker never fetches it over
 * the network at runtime — see ADR 0002 for the four reasons why.
 */
export interface KeyProvider {
  /**
   * Returns the Root KEK for a given version as a non-extractable CryptoKey.
   *
   * Takes a version rather than always returning "the current key" because
   * rotation requires both the outgoing and incoming keys to be usable at once:
   * existing rows are still wrapped under the old version until re-wrapped.
   */
  getRootKey(version: number): Promise<CryptoKey>;

  /** The version new wrapping operations should use. */
  currentVersion(): number;
}

/** Ciphertext plus the IV it was produced with. The GCM tag is inside `ciphertext`. */
export interface SealedBytes {
  ciphertext: Bytes;
  /** 96-bit, unique per operation. Reuse under one key breaks AES-GCM entirely. */
  iv: Bytes;
}

/**
 * Additional data bound to a secret's ciphertext.
 *
 * Moving a ciphertext row to another environment, secret, or version makes
 * decryption fail rather than silently succeed.
 */
export interface EncryptionContext {
  orgId: string;
  environmentId: string;
  secretId: string;
  version: number;
}

/** A wrapped key as stored in `org_keys` / `env_keys`. */
export interface WrappedKey extends SealedBytes {
  algorithm: CipherAlgorithm;
  /** This key's own version. */
  version: number;
}

/** A wrapped Org Master Key, which additionally records which root wrapped it. */
export interface WrappedOrgKey extends WrappedKey {
  rootKeyVersion: number;
}

/** A ciphertext as stored in `secret_versions`. */
export interface EncryptedValue extends SealedBytes {
  algorithm: CipherAlgorithm;
}

/**
 * Raised when decryption fails, for any reason.
 *
 * Carries no detail by design. Wrong key, wrong AAD, truncated input, flipped
 * bit, and forged tag are indistinguishable to the caller: telling an attacker
 * which part of their guess was wrong is a meaningful oracle, and no legitimate
 * caller needs to know.
 */
export class DecryptionError extends Error {
  constructor() {
    super('Decryption failed');
    this.name = 'DecryptionError';
  }
}

/**
 * Raised when a stored record references a key version the provider cannot
 * supply — typically a root key that was retired before all rows were re-wrapped.
 */
export class UnknownKeyVersionError extends Error {
  constructor(readonly requestedVersion: number) {
    super(`No key available for version ${requestedVersion}`);
    this.name = 'UnknownKeyVersionError';
  }
}
