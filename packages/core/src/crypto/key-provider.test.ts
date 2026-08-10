import { describe, expect, it } from 'vitest';
import { KEY_LENGTH } from './aead';
import { randomBytes, toBase64Url } from './encoding';
import {
  InMemoryKeyProvider,
  InvalidRootKeyMaterialError,
  keyProviderFromEnv,
  keyProviderFromSecretsStore,
  parseRootKeyMaterial,
} from './key-provider';
import { UnknownKeyVersionError } from './types';

const key1 = toBase64Url(randomBytes(KEY_LENGTH));
const key2 = toBase64Url(randomBytes(KEY_LENGTH));

describe('parseRootKeyMaterial', () => {
  it('parses a single-key map', () => {
    const material = parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 1);

    expect(material.currentVersion).toBe(1);
    expect(material.keys.size).toBe(1);
    expect(material.keys.get(1)).toHaveLength(KEY_LENGTH);
  });

  // Rotation requires both keys readable at once: rows wrapped under version 1
  // stay readable until every one has been re-wrapped under version 2.
  it('parses a multi-key map mid-rotation', () => {
    const material = parseRootKeyMaterial(JSON.stringify({ 1: key1, 2: key2 }), 2);

    expect(material.currentVersion).toBe(2);
    expect([...material.keys.keys()].sort()).toEqual([1, 2]);
  });

  it.each([
    ['not JSON', 'definitely not json', 1],
    ['a JSON array', '[]', 1],
    ['a JSON string', '"key"', 1],
    ['null', 'null', 1],
    ['an empty object', '{}', 1],
  ])('rejects %s', (_label, json, version) => {
    expect(() => parseRootKeyMaterial(json, version)).toThrow(InvalidRootKeyMaterialError);
  });

  // `Number('1.5')` and `Number('0x2')` both produce plausible-looking versions.
  // Strict parsing means a typo fails the deploy instead of silently creating a
  // key version nothing references.
  it.each(['0', '1.5', '0x2', '-1', 'one', '01', ' 1'])(
    'rejects the malformed version key "%s"',
    (versionKey) => {
      expect(() => parseRootKeyMaterial(JSON.stringify({ [versionKey]: key1 }), 1)).toThrow(
        InvalidRootKeyMaterialError,
      );
    },
  );

  it('rejects a key that is not a string', () => {
    expect(() => parseRootKeyMaterial('{"1": 12345}', 1)).toThrow(InvalidRootKeyMaterialError);
  });

  it('rejects a key that is not valid base64url', () => {
    expect(() => parseRootKeyMaterial(JSON.stringify({ 1: 'not base64url!!' }), 1)).toThrow(
      InvalidRootKeyMaterialError,
    );
  });

  // A 128-bit key where 256 is expected would otherwise fail much later, as an
  // unexplained decryption error on a customer request.
  it('rejects a key of the wrong length', () => {
    for (const length of [16, 31, 33, 64]) {
      expect(() =>
        parseRootKeyMaterial(JSON.stringify({ 1: toBase64Url(randomBytes(length)) }), 1),
      ).toThrow(InvalidRootKeyMaterialError);
    }
  });

  it('rejects a currentVersion that is not in the map', () => {
    expect(() => parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 2)).toThrow(
      InvalidRootKeyMaterialError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid currentVersion %s', (version) => {
    expect(() => parseRootKeyMaterial(JSON.stringify({ 1: key1 }), version)).toThrow(
      InvalidRootKeyMaterialError,
    );
  });

  it('never echoes key material in an error message', () => {
    try {
      parseRootKeyMaterial(JSON.stringify({ 1: toBase64Url(randomBytes(16)) }), 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('=');
      expect((error as Error).message).toMatch(/must be 32 bytes/);
    }
  });
});

describe('InMemoryKeyProvider', () => {
  it('returns a usable non-extractable key', async () => {
    const provider = new InMemoryKeyProvider(parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 1));
    const key = await provider.getRootKey(1);

    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('reports the current version', () => {
    const provider = new InMemoryKeyProvider(
      parseRootKeyMaterial(JSON.stringify({ 1: key1, 2: key2 }), 2),
    );
    expect(provider.currentVersion()).toBe(2);
    expect(provider.availableVersions()).toEqual([1, 2]);
  });

  it('serves older versions during a rotation', async () => {
    const provider = new InMemoryKeyProvider(
      parseRootKeyMaterial(JSON.stringify({ 1: key1, 2: key2 }), 2),
    );

    await expect(provider.getRootKey(1)).resolves.toBeDefined();
    await expect(provider.getRootKey(2)).resolves.toBeDefined();
  });

  // Reached when a rotation retires a key before every row was re-wrapped.
  // A specific error is far more actionable than a generic decryption failure.
  it('raises a specific error for an unavailable version', async () => {
    const provider = new InMemoryKeyProvider(parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 1));

    await expect(provider.getRootKey(2)).rejects.toThrow(UnknownKeyVersionError);
    await expect(provider.getRootKey(2)).rejects.toThrow(/version 2/);
  });

  it('caches the imported key rather than re-importing per call', async () => {
    const provider = new InMemoryKeyProvider(parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 1));

    expect(await provider.getRootKey(1)).toBe(await provider.getRootKey(1));
  });

  it('shares one import between concurrent callers during a cold start', async () => {
    const provider = new InMemoryKeyProvider(parseRootKeyMaterial(JSON.stringify({ 1: key1 }), 1));

    const [a, b, c] = await Promise.all([
      provider.getRootKey(1),
      provider.getRootKey(1),
      provider.getRootKey(1),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('keyProviderFromSecretsStore', () => {
  it('reads the binding once and builds a provider', async () => {
    let reads = 0;
    const binding = {
      get: async () => {
        reads += 1;
        return JSON.stringify({ 1: key1 });
      },
    };

    const provider = await keyProviderFromSecretsStore(binding, 1);

    await provider.getRootKey(1);
    await provider.getRootKey(1);
    expect(reads).toBe(1);
  });

  it('surfaces invalid material as a configuration error, not a runtime surprise', async () => {
    await expect(keyProviderFromSecretsStore({ get: async () => 'garbage' }, 1)).rejects.toThrow(
      InvalidRootKeyMaterialError,
    );
  });
});

describe('keyProviderFromEnv', () => {
  it('builds from environment variables', () => {
    const provider = keyProviderFromEnv({
      XECRET_ROOT_KEYS: JSON.stringify({ 1: key1 }),
      XECRET_ROOT_KEY_VERSION: '1',
    });
    expect(provider.currentVersion()).toBe(1);
  });

  it('defaults to version 1 when unspecified', () => {
    expect(
      keyProviderFromEnv({ XECRET_ROOT_KEYS: JSON.stringify({ 1: key1 }) }).currentVersion(),
    ).toBe(1);
  });

  it('points at Phase.dev when the variable is missing', () => {
    expect(() => keyProviderFromEnv({})).toThrow(/phase run/);
  });
});
