import { orgValueAad } from './aad';
import type { OrgValuePurpose } from './aad';
import { importAesKey, open, seal } from './aead';
import { utf8Decode, utf8Encode } from './encoding';
import { generateKeyBytes, unwrapEnvKey, unwrapOrgKey, wrapEnvKey, wrapOrgKey } from './keys';
import { decryptSecretValue, encryptSecretValue } from './secrets';
import { DecryptionError } from './types';
import type {
  Bytes,
  EncryptedValue,
  EncryptionContext,
  KeyProvider,
  SealedOrgValue,
  WrappedKey,
  WrappedOrgKey,
} from './types';

/**
 * The largest value `sealOrgValue` accepts. A signing secret is under a hundred
 * bytes; the ceiling exists so the method cannot quietly become a general-purpose
 * blob store under the organisation's root of trust.
 */
export const MAX_ORG_VALUE_BYTES = 4096;

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

  /**
   * Seals a small value directly under the Org Master Key, bound by its AAD to
   * the organisation, the purpose and the row that will store it.
   *
   * ── Why the org key, and not an environment key ──
   * A webhook's signing secret belongs to the organisation, not to any one
   * environment: one endpoint receives events from every project. The server
   * must be able to read it on every delivery, so it cannot be hashed like a
   * token; and it must not sit in the database in a form a dump yields, so it
   * cannot be plaintext. The org key is the level of the hierarchy whose scope
   * matches, and a Root KEK rotation re-wraps the org key and leaves these
   * readable without touching a row.
   *
   * The `purpose` is a closed list (`OrgValuePurpose`), so a value sealed for
   * one use cannot be opened as another.
   */
  async sealOrgValue(params: {
    orgId: string;
    orgKey: WrappedOrgKey;
    purpose: OrgValuePurpose;
    resourceId: string;
    plaintext: string;
  }): Promise<SealedOrgValue> {
    const plaintextBytes = utf8Encode(params.plaintext);
    if (plaintextBytes.length > MAX_ORG_VALUE_BYTES) {
      plaintextBytes.fill(0);
      throw new TypeError(`An org-sealed value may be at most ${MAX_ORG_VALUE_BYTES} bytes`);
    }

    const aad = orgValueAad({
      orgId: params.orgId,
      purpose: params.purpose,
      resourceId: params.resourceId,
      orgKeyVersion: params.orgKey.version,
    });
    const orgKeyBytes = await this.#openOrgKey(params.orgId, params.orgKey);

    try {
      const key = await importAesKey(orgKeyBytes, ['encrypt']);
      const sealed = await seal(key, plaintextBytes, aad);
      return { ...sealed, keyVersion: params.orgKey.version };
    } finally {
      orgKeyBytes.fill(0);
      plaintextBytes.fill(0);
    }
  }

  /**
   * Opens a value sealed by {@link sealOrgValue}.
   *
   * `orgKey` must be the version recorded on the sealed value: the caller loads
   * that row, not the organisation's current key. A mismatch is refused as a
   * `DecryptionError` before anything is tried — the same detail-free failure as
   * a wrong AAD, a wrong key or a flipped bit, because a caller learning *which*
   * of those it was learns something about the rows it was handed.
   */
  async openOrgValue(params: {
    orgId: string;
    orgKey: WrappedOrgKey;
    purpose: OrgValuePurpose;
    resourceId: string;
    sealed: SealedOrgValue;
  }): Promise<string> {
    if (params.sealed.keyVersion !== params.orgKey.version) throw new DecryptionError();

    const aad = orgValueAad({
      orgId: params.orgId,
      purpose: params.purpose,
      resourceId: params.resourceId,
      orgKeyVersion: params.sealed.keyVersion,
    });
    const orgKeyBytes = await this.#openOrgKey(params.orgId, params.orgKey);

    try {
      const key = await importAesKey(orgKeyBytes, ['decrypt']);
      const plaintextBytes = await open(key, params.sealed, aad);
      try {
        return utf8Decode(plaintextBytes);
      } finally {
        plaintextBytes.fill(0);
      }
    } finally {
      orgKeyBytes.fill(0);
    }
  }

  async #openOrgKey(orgId: string, wrapped: WrappedOrgKey): Promise<Bytes> {
    // Uses the version recorded on the row, not the current version: during a
    // rotation these differ, and reading the row's own version is what keeps
    // not-yet-re-wrapped organisations working.
    const rootKey = await this.#keys.getRootKey(wrapped.rootKeyVersion);
    return unwrapOrgKey({ rootKey, orgId, wrapped });
  }
}
