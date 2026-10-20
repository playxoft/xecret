import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import { KEY_LENGTH } from './aead';
import { randomBytes, toBase64Url } from './encoding';
import { EnvelopeService, MAX_ORG_VALUE_BYTES } from './envelope-service';
import { InMemoryKeyProvider, parseRootKeyMaterial } from './key-provider';
import { rewrapOrgKey } from './keys';
import { DecryptionError } from './types';

function provider(versions: Record<number, string>, current: number): InMemoryKeyProvider {
  return new InMemoryKeyProvider(parseRootKeyMaterial(JSON.stringify(versions), current));
}

const rootV1 = toBase64Url(randomBytes(KEY_LENGTH));
const rootV2 = toBase64Url(randomBytes(KEY_LENGTH));

/** Mirrors what the application layer does with rows fetched from the database. */
async function setUpTenant(service: EnvelopeService) {
  const orgId = uuidv7();
  const environmentId = uuidv7();

  const orgKey = await service.createOrgKey(orgId);
  const envKey = await service.createEnvKey({ orgId, environmentId, orgKey });

  return { orgId, environmentId, orgKey, envKey };
}

describe('EnvelopeService', () => {
  it('walks the full hierarchy: root → org → env → secret', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const { orgId, environmentId, orgKey, envKey } = await setUpTenant(service);

    const secretId = uuidv7();
    const context = { orgId, environmentId, secretId, version: 1 };

    const envKeyBytes = await service.openEnvKey({ orgId, environmentId, orgKey, envKey });
    const encrypted = await service.encrypt(envKeyBytes, context, 'super-secret-value');

    expect(await service.decrypt(envKeyBytes, context, encrypted)).toBe('super-secret-value');
  });

  it('stamps the current root version onto a new org key', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1, 2: rootV2 }, 2));
    expect((await service.createOrgKey(uuidv7())).rootKeyVersion).toBe(2);
  });

  it('unwraps using the version recorded on the row, not the current one', async () => {
    // An org created before a rotation is still on version 1 while the provider's
    // current version is 2. Reading the row's own version is what keeps
    // not-yet-re-wrapped organisations working.
    const before = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const tenant = await setUpTenant(before);
    expect(tenant.orgKey.rootKeyVersion).toBe(1);

    const after = new EnvelopeService(provider({ 1: rootV1, 2: rootV2 }, 2));
    await expect(
      after.openEnvKey({
        orgId: tenant.orgId,
        environmentId: tenant.environmentId,
        orgKey: tenant.orgKey,
        envKey: tenant.envKey,
      }),
    ).resolves.toHaveLength(KEY_LENGTH);
  });

  it('keeps secrets readable across a full root rotation', async () => {
    const beforeRotation = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const { orgId, environmentId, orgKey, envKey } = await setUpTenant(beforeRotation);

    const secretId = uuidv7();
    const context = { orgId, environmentId, secretId, version: 1 };

    const envKeyBytes = await beforeRotation.openEnvKey({ orgId, environmentId, orgKey, envKey });
    const encrypted = await beforeRotation.encrypt(envKeyBytes, context, 'value-from-before');

    // Rotate: re-wrap the org key only. No env key, no ciphertext is rewritten.
    const rotatedProvider = provider({ 1: rootV1, 2: rootV2 }, 2);
    const rotatedOrgKey = await rewrapOrgKey({
      oldRootKey: await rotatedProvider.getRootKey(1),
      newRootKey: await rotatedProvider.getRootKey(2),
      newRootKeyVersion: 2,
      orgId,
      wrapped: orgKey,
    });

    // After rotation the old root can be retired entirely.
    const afterRotation = new EnvelopeService(provider({ 2: rootV2 }, 2));
    const recoveredEnvKey = await afterRotation.openEnvKey({
      orgId,
      environmentId,
      orgKey: rotatedOrgKey,
      envKey,
    });

    expect(await afterRotation.decrypt(recoveredEnvKey, context, encrypted)).toBe(
      'value-from-before',
    );
  });

  it('isolates tenants: one org cannot open another org key', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const a = await setUpTenant(service);
    const b = await setUpTenant(service);

    // Same Root KEK, different organisation — the AAD binding is what separates
    // them, since there is no per-tenant root key.
    await expect(
      service.openEnvKey({
        orgId: a.orgId,
        environmentId: a.environmentId,
        orgKey: b.orgKey,
        envKey: a.envKey,
      }),
    ).rejects.toThrow(DecryptionError);
  });

  it('isolates environments within one organisation', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const orgId = uuidv7();
    const orgKey = await service.createOrgKey(orgId);

    const development = uuidv7();
    const production = uuidv7();
    const devKey = await service.createEnvKey({ orgId, environmentId: development, orgKey });
    const prodKey = await service.createEnvKey({ orgId, environmentId: production, orgKey });

    // Presenting the production key as the development one must fail.
    await expect(
      service.openEnvKey({ orgId, environmentId: development, orgKey, envKey: prodKey }),
    ).rejects.toThrow(DecryptionError);

    await expect(
      service.openEnvKey({ orgId, environmentId: production, orgKey, envKey: devKey }),
    ).rejects.toThrow(DecryptionError);
  });

  it('generates a distinct key for every environment', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const orgId = uuidv7();
    const orgKey = await service.createOrgKey(orgId);

    const keys = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const environmentId = uuidv7();
      const envKey = await service.createEnvKey({ orgId, environmentId, orgKey });
      keys.add(toBase64Url(await service.openEnvKey({ orgId, environmentId, orgKey, envKey })));
    }

    expect(keys.size).toBe(10);
  });

  describe('values sealed under the org key (P19 §5)', () => {
    const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

    async function sealed(service: EnvelopeService) {
      const orgId = uuidv7();
      const webhookId = uuidv7();
      const orgKey = await service.createOrgKey(orgId);
      const value = await service.sealOrgValue({
        orgId,
        orgKey,
        purpose: 'webhook-secret',
        resourceId: webhookId,
        plaintext: SECRET,
      });
      return { orgId, webhookId, orgKey, value };
    }

    it('round-trips, and records the version of the org key that sealed it', async () => {
      const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
      const { orgId, webhookId, orgKey, value } = await sealed(service);

      expect(value.keyVersion).toBe(orgKey.version);
      expect(new TextDecoder().decode(value.ciphertext)).not.toContain('whsec_');
      expect(
        await service.openOrgValue({
          orgId,
          orgKey,
          purpose: 'webhook-secret',
          resourceId: webhookId,
          sealed: value,
        }),
      ).toBe(SECRET);
    });

    it('refuses to open on another row, another organisation or another org key', async () => {
      const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
      const { orgId, webhookId, orgKey, value } = await sealed(service);
      const open = (over: Partial<Parameters<EnvelopeService['openOrgValue']>[0]>) =>
        service.openOrgValue({
          orgId,
          orgKey,
          purpose: 'webhook-secret',
          resourceId: webhookId,
          sealed: value,
          ...over,
        });

      // Copied onto another webhook's row: the AAD names the row.
      await expect(open({ resourceId: uuidv7() })).rejects.toThrow(DecryptionError);
      // Another organisation's key, presented under this organisation's id.
      const other = await service.createOrgKey(uuidv7());
      await expect(open({ orgKey: other })).rejects.toThrow(DecryptionError);
      // A row claiming a different org key version than the key it is opened with.
      await expect(open({ sealed: { ...value, keyVersion: 2 } })).rejects.toThrow(DecryptionError);
      // A flipped bit.
      const tampered = new Uint8Array(value.ciphertext);
      tampered[0] = tampered[0]! ^ 1;
      await expect(open({ sealed: { ...value, ciphertext: tampered } })).rejects.toThrow(
        DecryptionError,
      );
    });

    it('survives a Root KEK rotation, which re-wraps the org key and nothing else', async () => {
      const before = new EnvelopeService(provider({ 1: rootV1 }, 1));
      const { orgId, webhookId, orgKey, value } = await sealed(before);

      const rotatedProvider = provider({ 1: rootV1, 2: rootV2 }, 2);
      const rotated = await rewrapOrgKey({
        oldRootKey: await rotatedProvider.getRootKey(1),
        newRootKey: await rotatedProvider.getRootKey(2),
        newRootKeyVersion: 2,
        orgId,
        wrapped: orgKey,
      });

      const after = new EnvelopeService(provider({ 2: rootV2 }, 2));
      expect(
        await after.openOrgValue({
          orgId,
          orgKey: rotated,
          purpose: 'webhook-secret',
          resourceId: webhookId,
          sealed: value,
        }),
      ).toBe(SECRET);
    });

    it('refuses to seal more than a small value', async () => {
      const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
      const orgId = uuidv7();
      await expect(
        service.sealOrgValue({
          orgId,
          orgKey: await service.createOrgKey(orgId),
          purpose: 'webhook-secret',
          resourceId: uuidv7(),
          plaintext: 'x'.repeat(MAX_ORG_VALUE_BYTES + 1),
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  // Cryptographic erasure: dropping the env key row makes every secret in that
  // environment permanently unreadable without touching a ciphertext row.
  it('renders an environment unreadable once its data key is gone', async () => {
    const service = new EnvelopeService(provider({ 1: rootV1 }, 1));
    const { orgId, environmentId, orgKey, envKey } = await setUpTenant(service);

    const context = { orgId, environmentId, secretId: uuidv7(), version: 1 };
    const envKeyBytes = await service.openEnvKey({ orgId, environmentId, orgKey, envKey });
    const encrypted = await service.encrypt(envKeyBytes, context, 'to be erased');

    // Simulate the key row being deleted: a replacement key cannot read it.
    const replacementKey = await service.createEnvKey({ orgId, environmentId, orgKey });
    const replacementBytes = await service.openEnvKey({
      orgId,
      environmentId,
      orgKey,
      envKey: replacementKey,
    });

    await expect(service.decrypt(replacementBytes, context, encrypted)).rejects.toThrow(
      DecryptionError,
    );
  });
});
