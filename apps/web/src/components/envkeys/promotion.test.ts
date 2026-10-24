import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeValueHmac,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateSigningKeyPair,
  toBase64Url,
} from '@xecret/core/crypto/client';
import { DEFAULT_SECRET_POLICY } from '@xecret/core/policy';
import { uuidv7 } from '@xecret/core/ids';

import { parseWith } from '@/server/http';
import { promoteClientBody } from '@/server/schemas/secrets';
import { holdVaultKeys, releaseVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import { sealGrantFor } from './env-keys';
import { holdEnvKey, releaseEnvKeys } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import {
  buildPromotionBody,
  buildPromotionDiff,
  defaultSelection,
  promotionPolicyProblems,
  readSnapshot,
  sameValue,
  SnapshotUnavailableError,
} from './promotion';
import type { EnvironmentSnapshot, OpenedSecret } from './promotion';
import { decryptValue, encryptValue } from './secret-crypto';
import type { EnvironmentKeys } from './types';

/**
 * Promotion, against real cryptography.
 *
 * The property that matters is not "did we call encrypt" — it is "does the
 * value we sent open in the *target*, under the target's key, for the row and
 * version it lands on, and does its tag match what the target's HMAC key says
 * about that plaintext". A value sealed with the source's AAD, or for the
 * version it was read at, stores cleanly behind a 200 and opens for nobody,
 * ever. So every assertion below is an open, and every body is run through the
 * server's own schema.
 */

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const SOURCE_ENV = '018f3f6a-0000-7000-8000-0000000000b1';
const TARGET_ENV = '018f3f6a-0000-7000-8000-0000000000b2';
const SOURCE_EDK = '018f3f6a-0000-7000-8000-0000000000c1';
const TARGET_EDK = '018f3f6a-0000-7000-8000-0000000000c2';
const USER_ID = '018f3f6a-0000-7000-8000-0000000000d1';

const responses = new Map<string, unknown>();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => Promise.resolve(responses.get(`GET ${path}`) ?? {})),
      post: vi.fn(() => Promise.resolve({})),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

function material(environmentId: string, envDataKeyId: string): EnvKeyMaterial {
  return {
    environmentId,
    envDataKeyId,
    edkVersion: 1,
    edk: generateEnvironmentDataKey(),
    ehk: generateEnvironmentHmacKey(),
  };
}

function opened(partial: Partial<OpenedSecret> & { name: string }): OpenedSecret {
  return { id: uuidv7(), version: 1, valueType: 'string', value: 'v', ...partial };
}

function snapshot(
  environmentId: string,
  key: EnvKeyMaterial,
  secrets: OpenedSecret[],
): EnvironmentSnapshot {
  return {
    ref: {
      orgSlug: 'acme',
      projectSlug: 'api',
      envSlug: environmentId === SOURCE_ENV ? 'staging' : 'production',
    },
    material: key,
    secrets: new Map(secrets.map((secret) => [secret.name, secret])),
  };
}

beforeEach(() => {
  responses.clear();
  releaseEnvKeys();
  releaseVaultKeys();
});

describe('buildPromotionDiff', () => {
  const source = material(SOURCE_ENV, SOURCE_EDK);
  const target = material(TARGET_ENV, TARGET_EDK);

  it('classifies every name either side holds, in name order', () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'ADDED', value: 'new' }),
        opened({ name: 'CHANGED', value: 'two' }),
        opened({ name: 'SAME', value: 'same' }),
        opened({ name: 'RETYPED', value: '8080', valueType: 'int' }),
      ]),
      snapshot(TARGET_ENV, target, [
        opened({ name: 'CHANGED', value: 'one' }),
        opened({ name: 'SAME', value: 'same' }),
        opened({ name: 'RETYPED', value: '8080', valueType: 'string' }),
        opened({ name: 'ONLY_TARGET', value: 'x' }),
      ]),
    );

    expect(items.map((item) => [item.name, item.status])).toEqual([
      ['ADDED', 'added'],
      ['CHANGED', 'changed'],
      ['ONLY_TARGET', 'removed'],
      ['RETYPED', 'changed'],
      ['SAME', 'unchanged'],
    ]);
    // The same value under a different type is a change, and says why.
    expect(items.find((item) => item.name === 'RETYPED')?.typeChanged).toBe(true);
  });

  it('compares values the way the server tag does: after NFC normalisation', () => {
    // "é" as one code point, and as "e" plus a combining accent.
    expect(sameValue('café', 'café')).toBe(true);
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [opened({ name: 'CAFE', value: 'café' })]),
      snapshot(TARGET_ENV, target, [opened({ name: 'CAFE', value: 'café' })]),
    );
    expect(items[0]?.status).toBe('unchanged');
  });

  it('says so when either side could not be opened, rather than guessing', () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'LOCKED_SOURCE', value: null }),
        opened({ name: 'LOCKED_TARGET', value: 'v' }),
      ]),
      snapshot(TARGET_ENV, target, [opened({ name: 'LOCKED_TARGET', value: null })]),
    );
    expect(items.find((item) => item.name === 'LOCKED_SOURCE')?.status).toBe('unreadable');
    const unknown = items.find((item) => item.name === 'LOCKED_TARGET');
    expect(unknown?.status).toBe('changed');
    expect(unknown?.targetUnknown).toBe(true);
  });

  it('selects every addition and change by default, and never a removal', () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [opened({ name: 'A' }), opened({ name: 'B', value: '2' })]),
      snapshot(TARGET_ENV, target, [opened({ name: 'B', value: '1' }), opened({ name: 'C' })]),
    );
    expect([...defaultSelection(items)].sort()).toEqual(['A', 'B']);
  });
});

describe('buildPromotionBody', () => {
  let target: EnvKeyMaterial;
  let source: EnvKeyMaterial;

  beforeEach(() => {
    target = material(TARGET_ENV, TARGET_EDK);
    source = material(SOURCE_ENV, SOURCE_EDK);
    // `withEnvKey` refuses material the store is not holding — the in-flight
    // guard. The target's key is the one a promotion encrypts under.
    holdEnvKey(target);
  });

  it('encrypts each value for the target row, under the target key, at the version it will occupy', async () => {
    const existingId = uuidv7();
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'DATABASE_URL', value: 'postgres://staging-to-prod' }),
        opened({ name: 'NEW_KEY', value: 'brand new' }),
      ]),
      snapshot(TARGET_ENV, target, [
        opened({ id: existingId, name: 'DATABASE_URL', version: 4, value: 'postgres://old' }),
      ]),
    );

    const body = await buildPromotionBody({
      orgId: ORG_ID,
      sourceSlug: 'staging',
      target: snapshot(TARGET_ENV, target, []),
      items,
      selected: defaultSelection(items),
      dryRun: true,
    });

    // The body the server's own schema accepts.
    const parsed = parseWith(promoteClientBody, body);
    expect(parsed.source).toBe('staging');
    expect(parsed.dryRun).toBe(true);

    // No plaintext anywhere in what crosses the network.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('postgres://staging-to-prod');
    expect(wire).not.toContain('brand new');

    const existing = parsed.writes.find((write) => write.name === 'DATABASE_URL')!;
    // The target's row and the version after its current one — not the source's.
    expect(existing.id).toBe(existingId);
    expect(existing.expectedVersion).toBe(5);
    expect(existing.value.envDataKeyId).toBe(TARGET_EDK);
    await expect(
      decryptValue({
        material: target,
        target: { orgId: ORG_ID, environmentId: TARGET_ENV, secretId: existingId },
        version: 5,
        ciphertext: existing.value.ciphertext,
      }),
    ).resolves.toBe('postgres://staging-to-prod');
    // The tag is the target's HMAC key over the plaintext — what lets the server
    // answer "unchanged" for a value the target already holds.
    expect(existing.value.valueHmac).toBe(
      toBase64Url(
        await computeValueHmac({ ehk: target.ehk, plaintext: 'postgres://staging-to-prod' }),
      ),
    );

    const created = parsed.writes.find((write) => write.name === 'NEW_KEY')!;
    expect(created.expectedVersion).toBe(1);
    expect(created.id).not.toBe(existingId);
    await expect(
      decryptValue({
        material: target,
        target: { orgId: ORG_ID, environmentId: TARGET_ENV, secretId: created.id },
        version: 1,
        ciphertext: created.value.ciphertext,
      }),
    ).resolves.toBe('brand new');
  });

  it('does not open under the source key, nor with the source row id', async () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [opened({ name: 'API_KEY', value: 'sk_live' })]),
      snapshot(TARGET_ENV, target, []),
    );
    const body = await buildPromotionBody({
      orgId: ORG_ID,
      sourceSlug: 'staging',
      target: snapshot(TARGET_ENV, target, []),
      items,
      selected: defaultSelection(items),
      dryRun: false,
    });
    const write = body.writes[0]!;

    await expect(
      decryptValue({
        material: source,
        target: { orgId: ORG_ID, environmentId: TARGET_ENV, secretId: write.id },
        version: 1,
        ciphertext: write.value.ciphertext,
      }),
    ).rejects.toThrow();
    await expect(
      decryptValue({
        material: target,
        target: { orgId: ORG_ID, environmentId: SOURCE_ENV, secretId: write.id },
        version: 1,
        ciphertext: write.value.ciphertext,
      }),
    ).rejects.toThrow();
  });

  it('keeps the source type, declares a template’s references, and removes only what was chosen', async () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'DSN', valueType: 'template', value: 'pg://${DB_USER}@${shared.DB_HOST}' }),
        opened({ name: 'PORT', valueType: 'int', value: '8080' }),
      ]),
      snapshot(TARGET_ENV, target, [opened({ name: 'GONE' }), opened({ name: 'KEPT' })]),
    );
    const selected = new Set([...defaultSelection(items), 'GONE']);

    const body = parseWith(
      promoteClientBody,
      await buildPromotionBody({
        orgId: ORG_ID,
        sourceSlug: 'staging',
        target: snapshot(TARGET_ENV, target, []),
        items,
        selected,
        dryRun: true,
      }),
    );

    const dsn = body.writes.find((write) => write.name === 'DSN')!;
    expect(dsn.valueType).toBe('template');
    expect(dsn.references).toEqual([
      { name: 'DB_USER' },
      { environment: 'shared', name: 'DB_HOST' },
    ]);
    const port = body.writes.find((write) => write.name === 'PORT')!;
    expect(port.valueType).toBe('int');
    expect(port.references).toBeUndefined();
    expect(body.removals).toEqual(['GONE']);
  });

  it('writes nothing for an unselected, unchanged or unreadable row', async () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'SKIPPED', value: 'a' }),
        opened({ name: 'SAME', value: 's' }),
        opened({ name: 'LOCKED', value: null }),
      ]),
      snapshot(TARGET_ENV, target, [opened({ name: 'SAME', value: 's' })]),
    );
    const body = await buildPromotionBody({
      orgId: ORG_ID,
      sourceSlug: 'staging',
      target: snapshot(TARGET_ENV, target, []),
      items,
      selected: new Set(['SAME', 'LOCKED']),
      dryRun: true,
    });
    expect(body.writes).toEqual([]);
    expect(body.removals).toEqual([]);
  });
});

describe('promotionPolicyProblems', () => {
  const source = material(SOURCE_ENV, SOURCE_EDK);
  const target = material(TARGET_ENV, TARGET_EDK);
  const policy = { ...DEFAULT_SECRET_POLICY, enabled: true };

  it('holds new names to the naming rule and every promoted value to the value rules', () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [
        opened({ name: 'lower_case', value: 'Zq8#kL2!xV9@mN4$pR7&' }),
        opened({ name: 'API_TOKEN', value: 'changeme' }),
        opened({ name: 'FINE', value: 'ok' }),
      ]),
      snapshot(TARGET_ENV, target, [opened({ name: 'API_TOKEN', value: 'old' })]),
    );
    const problems = promotionPolicyProblems(policy, items, defaultSelection(items), false);

    expect(problems.map((problem) => problem.name).sort()).toEqual(['API_TOKEN', 'lower_case']);
    // Never the value, in any message.
    expect(JSON.stringify(problems)).not.toContain('changeme');
  });

  it('asks nothing of a production-scoped policy when the target is not production', () => {
    const items = buildPromotionDiff(
      snapshot(SOURCE_ENV, source, [opened({ name: 'API_TOKEN', value: 'changeme' })]),
      snapshot(TARGET_ENV, target, []),
    );
    expect(
      promotionPolicyProblems(
        { ...policy, scope: 'production' },
        items,
        defaultSelection(items),
        false,
      ),
    ).toEqual([]);
  });
});

describe('readSnapshot', () => {
  const ref = { orgSlug: 'acme', projectSlug: 'api', envSlug: 'staging' };
  const pullPath =
    'GET /api/orgs/acme/projects/api/environments/staging/pull?bundle=2&layers=none&format=json';
  const listPath = 'GET /api/orgs/acme/projects/api/environments/staging/secrets?limit=200';

  function vault(): VaultKeyMaterial {
    const enc = generateEncryptionKeyPair();
    const sign = generateSigningKeyPair();
    return {
      userId: USER_ID,
      userKey: new Uint8Array(32),
      encPrivateKey: enc.privateKey,
      encPublicKey: enc.publicKey,
      signPrivateKey: sign.privateKey,
      signPublicKey: sign.publicKey,
    };
  }

  it('opens the grant that came with the values, and every value it can', async () => {
    const owner = vault();
    holdVaultKeys(owner);
    const edk = generateEnvironmentDataKey();
    const ehk = generateEnvironmentHmacKey();
    const grant = await sealGrantFor({
      vault: owner,
      environmentId: SOURCE_ENV,
      edkVersion: 1,
      edk,
      ehk,
      recipientKind: 'member',
      recipientId: USER_ID,
      recipientPublicKey: owner.encPublicKey,
    });

    const sealedKey: EnvKeyMaterial = {
      environmentId: SOURCE_ENV,
      envDataKeyId: SOURCE_EDK,
      edkVersion: 1,
      edk: edk.slice(),
      ehk: ehk.slice(),
    };
    const readableId = uuidv7();
    const readable = await encryptValue({
      material: sealedKey,
      target: { orgId: ORG_ID, environmentId: SOURCE_ENV, secretId: readableId },
      version: 3,
      plaintext: 'staging value',
    });

    const keys: EnvironmentKeys = {
      encryptionMode: 'e2ee',
      environmentId: SOURCE_ENV,
      activeEdk: { id: SOURCE_EDK, version: 1 },
      myGrant: { ...grant, signedByUserId: USER_ID },
      ehkExists: true,
      pendingGrants: null,
      needsRotation: null,
      missingGrants: null,
      currentMaxSecretVersion: 3,
    };

    responses.set(pullPath, {
      bundle: true,
      bundleVersion: 2,
      encryptionMode: 'e2ee',
      keys,
      secrets: [
        {
          id: readableId,
          name: 'DATABASE_URL',
          ciphertext: readable.ciphertext,
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: SOURCE_EDK,
          version: 3,
        },
        {
          // Written before a rotation, under a key this session never held.
          id: uuidv7(),
          name: 'OLD_VALUE',
          ciphertext: readable.ciphertext,
          clientAlgorithm: 'xk2.gcm',
          envDataKeyId: uuidv7(),
          version: 1,
        },
      ],
    });
    responses.set(listPath, {
      data: [
        { name: 'DATABASE_URL', valueType: 'url' },
        { name: 'OLD_VALUE', valueType: 'string' },
      ],
      nextCursor: null,
    });

    const read = await readSnapshot({ ref, orgId: ORG_ID, vault: owner, label: 'Staging' });

    expect(read.secrets.get('DATABASE_URL')).toMatchObject({
      id: readableId,
      version: 3,
      valueType: 'url',
      value: 'staging value',
    });
    // Not guessed: unreadable here, and said so.
    expect(read.secrets.get('OLD_VALUE')?.value).toBeNull();
  });

  it('refuses a server-mode environment by the missing bundle marker', async () => {
    responses.set(pullPath, { DATABASE_URL: 'postgres://flat-document' });
    await expect(
      readSnapshot({ ref, orgId: ORG_ID, vault: null, label: 'Staging' }),
    ).rejects.toBeInstanceOf(SnapshotUnavailableError);
  });
});
