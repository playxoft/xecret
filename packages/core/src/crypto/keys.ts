import { envKeyAad, orgKeyAad } from './aad';
import { importAesKey, KEY_LENGTH, open, seal } from './aead';
import { randomBytes } from './encoding';
import { DEFAULT_ALGORITHM } from './types';
import type { WrappedKey, WrappedOrgKey } from './types';
import type { Bytes } from './types';

/**
 * The key hierarchy: generating, wrapping, and unwrapping data keys.
 *
 * Keys are handled as raw bytes here rather than as `CryptoKey` objects because
 * wrapping requires the key material itself. Callers should treat the returned
 * `Bytes`s as sensitive: keep them for as long as a request needs and no
 * longer, and prefer passing them straight into the functions in `secrets.ts`.
 */

/** Fresh 256 bits of key material. */
export function generateKeyBytes(): Bytes {
  return randomBytes(KEY_LENGTH);
}

/** Wraps an Org Master Key under the Root KEK. */
export async function wrapOrgKey(params: {
  rootKey: CryptoKey;
  rootKeyVersion: number;
  orgId: string;
  keyVersion: number;
  keyBytes: Bytes;
}): Promise<WrappedOrgKey> {
  assertKeyLength(params.keyBytes);

  const sealed = await seal(
    params.rootKey,
    params.keyBytes,
    orgKeyAad(params.orgId, params.keyVersion),
  );

  return {
    ...sealed,
    algorithm: DEFAULT_ALGORITHM,
    version: params.keyVersion,
    rootKeyVersion: params.rootKeyVersion,
  };
}

/** Unwraps an Org Master Key. Throws `DecryptionError` if anything is off. */
export async function unwrapOrgKey(params: {
  rootKey: CryptoKey;
  orgId: string;
  wrapped: WrappedOrgKey;
}): Promise<Bytes> {
  return open(params.rootKey, params.wrapped, orgKeyAad(params.orgId, params.wrapped.version));
}

/** Wraps an Env Data Key under an Org Master Key. */
export async function wrapEnvKey(params: {
  orgKeyBytes: Bytes;
  orgId: string;
  environmentId: string;
  keyVersion: number;
  keyBytes: Bytes;
}): Promise<WrappedKey> {
  assertKeyLength(params.keyBytes);

  const orgKey = await importAesKey(params.orgKeyBytes, ['encrypt']);
  const sealed = await seal(
    orgKey,
    params.keyBytes,
    envKeyAad(params.orgId, params.environmentId, params.keyVersion),
  );

  return { ...sealed, algorithm: DEFAULT_ALGORITHM, version: params.keyVersion };
}

/** Unwraps an Env Data Key. Throws `DecryptionError` if anything is off. */
export async function unwrapEnvKey(params: {
  orgKeyBytes: Bytes;
  orgId: string;
  environmentId: string;
  wrapped: WrappedKey;
}): Promise<Bytes> {
  const orgKey = await importAesKey(params.orgKeyBytes, ['decrypt']);
  return open(
    orgKey,
    params.wrapped,
    envKeyAad(params.orgId, params.environmentId, params.wrapped.version),
  );
}

/**
 * Re-wraps an Org Master Key under a new Root KEK version.
 *
 * This is the whole of root-key rotation: unwrap with the old root, wrap with
 * the new one. No secret ciphertext is read, decrypted, or rewritten, which is
 * why rotating the root is cheap enough to do on a schedule rather than only
 * after an incident.
 */
export async function rewrapOrgKey(params: {
  oldRootKey: CryptoKey;
  newRootKey: CryptoKey;
  newRootKeyVersion: number;
  orgId: string;
  wrapped: WrappedOrgKey;
}): Promise<WrappedOrgKey> {
  const keyBytes = await unwrapOrgKey({
    rootKey: params.oldRootKey,
    orgId: params.orgId,
    wrapped: params.wrapped,
  });

  try {
    return await wrapOrgKey({
      rootKey: params.newRootKey,
      rootKeyVersion: params.newRootKeyVersion,
      orgId: params.orgId,
      // The org key itself is unchanged; only the wrapping changes. Bumping its
      // version here would orphan every env key wrapped under this version.
      keyVersion: params.wrapped.version,
      keyBytes,
    });
  } finally {
    keyBytes.fill(0);
  }
}

function assertKeyLength(keyBytes: Bytes): void {
  if (keyBytes.length !== KEY_LENGTH) {
    throw new TypeError(`Key material must be ${KEY_LENGTH} bytes, received ${keyBytes.length}`);
  }
}
