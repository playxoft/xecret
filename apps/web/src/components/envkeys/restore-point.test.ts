import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeValueHmac,
  encryptSecret,
  generateEncryptionKeyPair,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  generateSigningKeyPair,
  toBase64Url,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';

import { parseWith } from '@/server/http';
import { restorePointBody } from '@/server/schemas/secrets';
import { holdVaultKeys, releaseVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

import { sealGrantFor } from './env-keys';
import { holdEnvKey, releaseEnvKeys } from './env-key-store';
import type { EnvKeyMaterial } from './env-key-store';
import {
  isoToLocalInput,
  localInputToIso,
  openRestorePlan,
  partialRestoreNotice,
  writesValue,
} from './restore-point';
import type { RestorePlan, RestorePlanItem, RestorePlanKey } from './restore-point';
import { decryptValue } from './secret-crypto';

/**
 * The point-in-time restore executor, against real cryptography.
 *
 * The case this exists for is a value written *before a rotation*: sealed under
 * a key that is no longer active, opened from the retired key's grant the plan
 * serves, and written back under today's key for today's row. Every assertion
 * is an open or a tag comparison — the two things the server and the next
 * reader will actually do with what this produces.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

const ORG_ID = '018f3f6a-0000-7000-8000-0000000000a1';
const ENVIRONMENT_ID = '018f3f6a-0000-7000-8000-0000000000b1';
const RETIRED_EDK = '018f3f6a-0000-7000-8000-0000000000c1';
const ACTIVE_EDK = '018f3f6a-0000-7000-8000-0000000000c2';
const USER_ID = '018f3f6a-0000-7000-8000-0000000000d1';

function vaultFor(userId: string): VaultKeyMaterial {
  const enc = generateEncryptionKeyPair();
  const sign = generateSigningKeyPair();
  return {
    userId,
    userKey: new Uint8Array(32),
    encPrivateKey: enc.privateKey,
    encPublicKey: enc.publicKey,
    signPrivateKey: sign.privateKey,
    signPublicKey: sign.publicKey,
  };
}

/** A grant for one key version, as the plan serves the caller's own. */
async function planKey(
  vault: VaultKeyMaterial,
  version: number,
  edk: Bytes,
  ehk: Bytes,
): Promise<RestorePlanKey> {
  const grant = await sealGrantFor({
    vault,
    environmentId: ENVIRONMENT_ID,
    edkVersion: version,
    edk,
    ehk,
    recipientKind: 'member',
    recipientId: vault.userId,
    recipientPublicKey: vault.encPublicKey,
  });
  return {
    version,
    myGrant: {
      recipientPublicKey: grant.recipientPublicKey,
      edkSealed: grant.edkSealed,
      ehkSealed: grant.ehkSealed,
      signature: grant.signature,
      signedByUserId: vault.userId,
    },
  };
}

/** A historical value, sealed as the row and version it was written as. */
async function historical(params: {
  edk: Bytes;
  keyId: string;
  secretId: string;
  version: number;
  name: string;
  plaintext: string;
}) {
  return {
    id: params.secretId,
    name: params.name,
    ciphertext: await encryptSecret({
      edk: params.edk,
      context: {
        field: 'value',
        orgId: ORG_ID,
        environmentId: ENVIRONMENT_ID,
        secretId: params.secretId,
        version: params.version,
      },
      plaintext: params.plaintext,
    }),
    clientAlgorithm: 'xk2.gcm',
    envDataKeyId: params.keyId,
    version: params.version,
  };
}

function planWith(items: RestorePlanItem[], keys: Record<string, RestorePlanKey>): RestorePlan {
  return {
    at: '2026-10-19T14:30:00.000Z',
    window: { days: 30, earliest: '2026-09-20T00:00:00.000Z' },
    items,
    keys,
    counts: { update: 0, recreate: 0, delete: 0, unchanged: 0, unavailable: 0 },
  };
}

describe('openRestorePlan', () => {
  let vault: VaultKeyMaterial;
  /** Rotation replaces the EDK and keeps the EHK — the tag survives it. */
  let ehk: Bytes;
  let retiredEdk: Bytes;
  let current: EnvKeyMaterial;

  beforeEach(() => {
    releaseEnvKeys();
    releaseVaultKeys();
    vault = vaultFor(USER_ID);
    holdVaultKeys(vault);
    ehk = generateEnvironmentHmacKey();
    retiredEdk = generateEnvironmentDataKey();
    current = {
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: ACTIVE_EDK,
      edkVersion: 2,
      edk: generateEnvironmentDataKey(),
      ehk: ehk.slice(),
    };
    holdEnvKey(current);
  });

  it('opens a value under a retired key’s grant and re-encrypts it for today’s row and version', async () => {
    const rowId = uuidv7();
    const from = await historical({
      edk: retiredEdk,
      keyId: RETIRED_EDK,
      secretId: rowId,
      version: 2,
      name: 'DATABASE_URL',
      plaintext: 'postgres://as-it-was',
    });

    const plan = planWith(
      [
        {
          name: 'DATABASE_URL',
          action: 'update',
          secretId: rowId,
          // Today the row is at version 6; the restore lands as version 7.
          expectedVersion: 7,
          valueType: 'url',
          available: true,
          from,
        },
      ],
      { [RETIRED_EDK]: await planKey(vault, 1, retiredEdk, ehk) },
    );

    const opened = await openRestorePlan({ plan, vault, orgId: ORG_ID, material: current });

    expect(opened.blocked).toEqual([]);
    expect(opened.items[0]?.value).toBe('postgres://as-it-was');

    const body = parseWith(restorePointBody, {
      at: plan.at,
      writes: opened.writes,
      dryRun: true,
    });
    const write = body.writes[0]!;
    expect(write.id).toBe(rowId);
    expect(write.expectedVersion).toBe(7);
    // Under today's key — not the retired one it was read with.
    expect(write.value.envDataKeyId).toBe(ACTIVE_EDK);
    await expect(
      decryptValue({
        material: current,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: rowId },
        version: 7,
        ciphertext: write.value.ciphertext,
      }),
    ).resolves.toBe('postgres://as-it-was');
    // Not a copy: the old bytes would have been bound to version 2.
    expect(write.value.ciphertext).not.toBe(from.ciphertext);

    // The tag the server compares with the instant's own — the HMAC key is the
    // environment's, unchanged by the rotation, so the same plaintext tags the
    // same.
    expect(write.value.valueHmac).toBe(
      toBase64Url(await computeValueHmac({ ehk, plaintext: 'postgres://as-it-was' })),
    );

    expect(JSON.stringify(body)).not.toContain('postgres://as-it-was');
  });

  it('re-creates a deleted secret as a new row at version 1, under a fresh id', async () => {
    const deletedRowId = uuidv7();
    const from = await historical({
      edk: retiredEdk,
      keyId: RETIRED_EDK,
      secretId: deletedRowId,
      version: 3,
      name: 'STRIPE_KEY',
      plaintext: 'sk_live_restored',
    });

    const opened = await openRestorePlan({
      plan: planWith(
        [
          {
            name: 'STRIPE_KEY',
            action: 'recreate',
            secretId: null,
            expectedVersion: 1,
            valueType: 'string',
            available: true,
            from,
          },
        ],
        { [RETIRED_EDK]: await planKey(vault, 1, retiredEdk, ehk) },
      ),
      vault,
      orgId: ORG_ID,
      material: current,
    });

    const write = opened.writes[0]!;
    expect(write.expectedVersion).toBe(1);
    // A new row beside the deleted one, never the deleted row revived.
    expect(write.id).not.toBe(deletedRowId);
    await expect(
      decryptValue({
        material: current,
        target: { orgId: ORG_ID, environmentId: ENVIRONMENT_ID, secretId: write.id },
        version: 1,
        ciphertext: write.value.ciphertext,
      }),
    ).resolves.toBe('sk_live_restored');
  });

  it('declares a template’s references, re-parsed from the text it decrypted', async () => {
    const rowId = uuidv7();
    const opened = await openRestorePlan({
      plan: planWith(
        [
          {
            name: 'DSN',
            action: 'update',
            secretId: rowId,
            expectedVersion: 3,
            valueType: 'template',
            available: true,
            from: await historical({
              edk: current.edk,
              keyId: ACTIVE_EDK,
              secretId: rowId,
              version: 1,
              name: 'DSN',
              plaintext: 'pg://${DB_USER}@${prod.DB_HOST}',
            }),
          },
        ],
        { [ACTIVE_EDK]: await planKey(vault, 2, current.edk, ehk) },
      ),
      vault,
      orgId: ORG_ID,
      material: current,
    });

    expect(opened.writes[0]?.references).toEqual([
      { name: 'DB_USER' },
      { environment: 'prod', name: 'DB_HOST' },
    ]);
  });

  it('sends nothing for a deletion, an unchanged row or an unavailable value — and says why', async () => {
    const opened = await openRestorePlan({
      plan: planWith(
        [
          {
            name: 'CREATED_SINCE',
            action: 'delete',
            secretId: uuidv7(),
            expectedVersion: null,
            valueType: 'string',
            available: true,
            from: null,
          },
          {
            name: 'WRITTEN_UNDER_A_KEY_I_NEVER_HELD',
            action: 'update',
            secretId: uuidv7(),
            expectedVersion: 4,
            valueType: 'string',
            available: false,
            from: await historical({
              edk: retiredEdk,
              keyId: uuidv7(),
              secretId: uuidv7(),
              version: 1,
              name: 'WRITTEN_UNDER_A_KEY_I_NEVER_HELD',
              plaintext: 'x',
            }),
          },
        ],
        {},
      ),
      vault,
      orgId: ORG_ID,
      material: current,
    });

    expect(opened.writes).toEqual([]);
    expect(opened.blocked).toEqual([]);
    expect(opened.items.map((item) => item.problem)).toEqual([null, 'unavailable']);
  });

  it('blocks the restore when a value it owes does not open', async () => {
    const rowId = uuidv7();
    const otherVault = vaultFor('018f3f6a-0000-7000-8000-0000000000d2');
    const opened = await openRestorePlan({
      plan: planWith(
        [
          {
            name: 'DATABASE_URL',
            action: 'update',
            secretId: rowId,
            expectedVersion: 2,
            valueType: 'string',
            available: true,
            from: await historical({
              edk: retiredEdk,
              keyId: RETIRED_EDK,
              secretId: rowId,
              version: 1,
              name: 'DATABASE_URL',
              plaintext: 'unreachable',
            }),
          },
        ],
        // A grant sealed to somebody else's key — a vault reset, say — opens
        // for nobody here.
        { [RETIRED_EDK]: await planKey(otherVault, 1, retiredEdk, ehk) },
      ),
      vault,
      orgId: ORG_ID,
      material: current,
    });

    expect(opened.writes).toEqual([]);
    expect(opened.blocked).toEqual(['DATABASE_URL']);
    expect(opened.items[0]?.problem).toBe('unreadable');
  });

  it('refuses outright once the vault is locked', async () => {
    releaseVaultKeys();
    await expect(
      openRestorePlan({ plan: planWith([], {}), vault, orgId: ORG_ID, material: current }),
    ).rejects.toThrow(/locked/i);
  });
});

describe('the helpers around it', () => {
  it('writes a value exactly where the plan owes one', () => {
    const base: RestorePlanItem = {
      name: 'X',
      action: 'update',
      secretId: null,
      expectedVersion: 2,
      valueType: 'string',
      available: true,
      from: null,
    };
    expect(writesValue(base)).toBe(true);
    expect(writesValue({ ...base, available: false })).toBe(false);
    expect(writesValue({ ...base, expectedVersion: null })).toBe(false);
  });

  it('says, by name, when a restore would be partial (review round 1, L13)', () => {
    const base: RestorePlanItem = {
      name: 'X',
      action: 'update',
      secretId: null,
      expectedVersion: 2,
      valueType: 'string',
      available: true,
      from: null,
    };
    const whole = [{ item: base, problem: null }];
    expect(partialRestoreNotice(whole)).toBeNull();

    const one = partialRestoreNotice([
      ...whole,
      { item: { ...base, name: 'OLD_KEY', available: false }, problem: 'unavailable' as const },
    ]);
    expect(one).toMatch(/^This restore is partial\. OLD_KEY was written under a key/);
    expect(one).toContain('it stays exactly as it is');

    const two = partialRestoreNotice([
      { item: { ...base, name: 'A', available: false }, problem: 'unavailable' as const },
      { item: { ...base, name: 'B', available: false }, problem: 'unavailable' as const },
    ]);
    expect(two).toContain('A, B were written');
    // A value whose key was served but did not open blocks the restore; it is
    // not a partial one.
    expect(partialRestoreNotice([{ item: base, problem: 'unreadable' as const }])).toBeNull();
  });

  it('round-trips a local date-time through ISO 8601', () => {
    const iso = localInputToIso('2026-10-19T14:30');
    expect(iso).not.toBeNull();
    expect(isoToLocalInput(iso!)).toBe('2026-10-19T14:30');
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not a date')).toBeNull();
  });
});
