import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import { importAesKey, KEY_LENGTH } from './aead';
import { randomBytes, toBase64Url } from './encoding';
import {
  generateKeyBytes,
  rewrapOrgKey,
  unwrapEnvKey,
  unwrapOrgKey,
  wrapEnvKey,
  wrapOrgKey,
} from './keys';
import { DecryptionError } from './types';

async function rootKey(): Promise<CryptoKey> {
  return importAesKey(randomBytes(KEY_LENGTH));
}

describe('generateKeyBytes', () => {
  it('returns 256 bits', () => {
    expect(generateKeyBytes()).toHaveLength(KEY_LENGTH);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => toBase64Url(generateKeyBytes())));
    expect(seen.size).toBe(1000);
  });
});

describe('org key wrapping', () => {
  it('round-trips', async () => {
    const root = await rootKey();
    const orgId = uuidv7();
    const keyBytes = generateKeyBytes();

    const wrapped = await wrapOrgKey({
      rootKey: root,
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes,
    });

    expect(await unwrapOrgKey({ rootKey: root, orgId, wrapped })).toEqual(keyBytes);
  });

  it('records the root version that wrapped it, so rotation can find it', async () => {
    const wrapped = await wrapOrgKey({
      rootKey: await rootKey(),
      rootKeyVersion: 3,
      orgId: uuidv7(),
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    expect(wrapped.rootKeyVersion).toBe(3);
    expect(wrapped.version).toBe(1);
    expect(wrapped.algorithm).toBe('AES-256-GCM');
  });

  it('never stores the key material in the clear', async () => {
    const keyBytes = generateKeyBytes();
    const wrapped = await wrapOrgKey({
      rootKey: await rootKey(),
      rootKeyVersion: 1,
      orgId: uuidv7(),
      keyVersion: 1,
      keyBytes,
    });

    expect(toBase64Url(wrapped.ciphertext)).not.toContain(toBase64Url(keyBytes));
  });

  it('rejects key material of the wrong length', async () => {
    await expect(
      wrapOrgKey({
        rootKey: await rootKey(),
        rootKeyVersion: 1,
        orgId: uuidv7(),
        keyVersion: 1,
        keyBytes: randomBytes(16),
      }),
    ).rejects.toThrow(TypeError);
  });

  // An org key lifted from another tenant's row must not unwrap, even though the
  // Root KEK is shared across all organisations.
  it('cannot be unwrapped under a different organisation id', async () => {
    const root = await rootKey();
    const wrapped = await wrapOrgKey({
      rootKey: root,
      rootKeyVersion: 1,
      orgId: uuidv7(),
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(unwrapOrgKey({ rootKey: root, orgId: uuidv7(), wrapped })).rejects.toThrow(
      DecryptionError,
    );
  });

  it('cannot be unwrapped with a forged key version', async () => {
    const root = await rootKey();
    const orgId = uuidv7();
    const wrapped = await wrapOrgKey({
      rootKey: root,
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(
      unwrapOrgKey({ rootKey: root, orgId, wrapped: { ...wrapped, version: 2 } }),
    ).rejects.toThrow(DecryptionError);
  });

  it('cannot be unwrapped with the wrong root key', async () => {
    const orgId = uuidv7();
    const wrapped = await wrapOrgKey({
      rootKey: await rootKey(),
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(unwrapOrgKey({ rootKey: await rootKey(), orgId, wrapped })).rejects.toThrow(
      DecryptionError,
    );
  });
});

describe('env key wrapping', () => {
  it('round-trips', async () => {
    const orgKeyBytes = generateKeyBytes();
    const orgId = uuidv7();
    const environmentId = uuidv7();
    const keyBytes = generateKeyBytes();

    const wrapped = await wrapEnvKey({
      orgKeyBytes,
      orgId,
      environmentId,
      keyVersion: 1,
      keyBytes,
    });

    expect(await unwrapEnvKey({ orgKeyBytes, orgId, environmentId, wrapped })).toEqual(keyBytes);
  });

  // This is the cross-environment containment property: a `production` env key
  // must not unwrap when presented as a `development` one.
  it('cannot be unwrapped under a different environment id', async () => {
    const orgKeyBytes = generateKeyBytes();
    const orgId = uuidv7();

    const wrapped = await wrapEnvKey({
      orgKeyBytes,
      orgId,
      environmentId: uuidv7(),
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(
      unwrapEnvKey({ orgKeyBytes, orgId, environmentId: uuidv7(), wrapped }),
    ).rejects.toThrow(DecryptionError);
  });

  it('cannot be unwrapped under a different organisation', async () => {
    const orgKeyBytes = generateKeyBytes();
    const environmentId = uuidv7();

    const wrapped = await wrapEnvKey({
      orgKeyBytes,
      orgId: uuidv7(),
      environmentId,
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(
      unwrapEnvKey({ orgKeyBytes, orgId: uuidv7(), environmentId, wrapped }),
    ).rejects.toThrow(DecryptionError);
  });

  it('cannot be unwrapped with another organisation key', async () => {
    const orgId = uuidv7();
    const environmentId = uuidv7();

    const wrapped = await wrapEnvKey({
      orgKeyBytes: generateKeyBytes(),
      orgId,
      environmentId,
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(
      unwrapEnvKey({ orgKeyBytes: generateKeyBytes(), orgId, environmentId, wrapped }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('root key rotation', () => {
  it('re-wraps an org key under a new root without changing the key material', async () => {
    const oldRoot = await rootKey();
    const newRoot = await rootKey();
    const orgId = uuidv7();
    const keyBytes = generateKeyBytes();

    const before = await wrapOrgKey({
      rootKey: oldRoot,
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes,
    });

    const after = await rewrapOrgKey({
      oldRootKey: oldRoot,
      newRootKey: newRoot,
      newRootKeyVersion: 2,
      orgId,
      wrapped: before,
    });

    expect(after.rootKeyVersion).toBe(2);
    // The org key's own version must NOT change: bumping it would orphan every
    // env key wrapped under the previous version.
    expect(after.version).toBe(before.version);
    expect(await unwrapOrgKey({ rootKey: newRoot, orgId, wrapped: after })).toEqual(keyBytes);
  });

  it('leaves env keys and secrets untouched — the whole point of the hierarchy', async () => {
    const oldRoot = await rootKey();
    const newRoot = await rootKey();
    const orgId = uuidv7();
    const environmentId = uuidv7();

    const orgKeyBytes = generateKeyBytes();
    const envKeyBytes = generateKeyBytes();

    const wrappedOrg = await wrapOrgKey({
      rootKey: oldRoot,
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes: orgKeyBytes,
    });
    const wrappedEnv = await wrapEnvKey({
      orgKeyBytes,
      orgId,
      environmentId,
      keyVersion: 1,
      keyBytes: envKeyBytes,
    });

    const rotated = await rewrapOrgKey({
      oldRootKey: oldRoot,
      newRootKey: newRoot,
      newRootKeyVersion: 2,
      orgId,
      wrapped: wrappedOrg,
    });

    // The env key row was never rewritten, yet still opens after rotation.
    const recovered = await unwrapOrgKey({ rootKey: newRoot, orgId, wrapped: rotated });
    expect(
      await unwrapEnvKey({ orgKeyBytes: recovered, orgId, environmentId, wrapped: wrappedEnv }),
    ).toEqual(envKeyBytes);
  });

  it('fails cleanly if the old root is wrong, without writing anything', async () => {
    const orgId = uuidv7();
    const wrapped = await wrapOrgKey({
      rootKey: await rootKey(),
      rootKeyVersion: 1,
      orgId,
      keyVersion: 1,
      keyBytes: generateKeyBytes(),
    });

    await expect(
      rewrapOrgKey({
        oldRootKey: await rootKey(),
        newRootKey: await rootKey(),
        newRootKeyVersion: 2,
        orgId,
        wrapped,
      }),
    ).rejects.toThrow(DecryptionError);
  });
});
