import { generateKeyBytes, unwrapEnvKey, unwrapOrgKey, wrapEnvKey, wrapOrgKey } from './keys';
import { decryptSecretValue, encryptSecretValue } from './secrets';
import type {
  Bytes,
  EncryptedValue,
  EncryptionContext,
  KeyProvider,
  WrappedKey,
  WrappedOrgKey,
} from './types';

/**
 * Walks the key hierarchy so callers do not have to.
 *
 * The unwrap chain — root → org → env — is three steps that must happen in order
 * with the right AAD at each level. Expressing it once here means route handlers
 * never assemble it themselves, which is the same reasoning behind having a
 * single authorization function.
 *
 * This class holds no database access and no caching. It is constructed per
 * request with an already-resolved `KeyProvider`; deciding what to cache is the
 * application layer's job, because only it knows the request's tenancy.
 */
export class EnvelopeService {
  readonly #keys: KeyProvider;

  constructor(keyProvider: KeyProvider) {
    this.#keys = keyProvider;
  }

  /**
   * Creates a new Org Master Key, wrapped under the current root version.
   * Called once when an organisation is created.
   */
  async createOrgKey(orgId: string, keyVersion = 1): Promise<WrappedOrgKey> {
    const rootKeyVersion = this.#keys.currentVersion();
    const rootKey = await this.#keys.getRootKey(rootKeyVersion);
    const keyBytes = generateKeyBytes();

    try {
      return await wrapOrgKey({ rootKey, rootKeyVersion, orgId, keyVersion, keyBytes });
    } finally {
      keyBytes.fill(0);
    }
  }

  /**
   * Creates a new Env Data Key under an organisation's master key.
   * Called once when an environment is created.
   */
  async createEnvKey(params: {
    orgId: string;
    environmentId: string;
    orgKey: WrappedOrgKey;
    keyVersion?: number;
  }): Promise<WrappedKey> {
    const orgKeyBytes = await this.#openOrgKey(params.orgId, params.orgKey);
    const keyBytes = generateKeyBytes();

    try {
      return await wrapEnvKey({
        orgKeyBytes,
        orgId: params.orgId,
        environmentId: params.environmentId,
        keyVersion: params.keyVersion ?? 1,
        keyBytes,
      });
    } finally {
      keyBytes.fill(0);
      orgKeyBytes.fill(0);
    }
  }

  /**
   * Unwraps an environment's data key.
   *
   * Callers that handle several secrets in one request should call this once and
   * reuse the bytes rather than unwrapping per secret — that is what keeps the
   * bulk read path used by `xecret run` at a constant cost regardless of how many
   * secrets an environment holds.
   */
  async openEnvKey(params: {
    orgId: string;
    environmentId: string;
    orgKey: WrappedOrgKey;
    envKey: WrappedKey;
  }): Promise<Bytes> {
    const orgKeyBytes = await this.#openOrgKey(params.orgId, params.orgKey);

    try {
      return await unwrapEnvKey({
        orgKeyBytes,
        orgId: params.orgId,
        environmentId: params.environmentId,
        wrapped: params.envKey,
      });
    } finally {
      orgKeyBytes.fill(0);
    }
  }

  /** Encrypts one value under an already-unwrapped environment key. */
  async encrypt(
    envKeyBytes: Bytes,
    context: EncryptionContext,
    plaintext: string,
  ): Promise<EncryptedValue> {
    return encryptSecretValue({ envKeyBytes, context, plaintext });
  }

  /** Decrypts one value under an already-unwrapped environment key. */
  async decrypt(
    envKeyBytes: Bytes,
    context: EncryptionContext,
    encrypted: EncryptedValue,
  ): Promise<string> {
    return decryptSecretValue({ envKeyBytes, context, encrypted });
  }

  async #openOrgKey(orgId: string, wrapped: WrappedOrgKey): Promise<Bytes> {
    // Uses the version recorded on the row, not the current version: during a
    // rotation these differ, and reading the row's own version is what keeps
    // not-yet-re-wrapped organisations working.
    const rootKey = await this.#keys.getRootKey(wrapped.rootKeyVersion);
    return unwrapOrgKey({ rootKey, orgId, wrapped });
  }
}
