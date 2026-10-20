import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { findGrantsForPrincipalOnKeys } from './env-keys';
import {
  addSecretVersion,
  createSecret,
  loadEnvironmentSecretsAt,
  softDeleteSecret,
} from './secrets';

/**
 * The reads behind point-in-time restore (P19 §4) — an environment as it stood
 * at an instant, and a principal's grants on retired keys — against a real
 * PostgreSQL with every migration applied.
 *
 * Time is set by hand: each row's timestamp is written after it is created, so
 * "at 14:30 yesterday" means exactly what the test says it means.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const ascii = (value: string) => new TextEncoder().encode(value);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

interface World {
  orgId: string;
  userId: string;
  environmentId: string;
  keyId: string;
}

async function world(): Promise<World> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const keyId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `pitr-${userId.slice(0, 8)}@example.com`],
  );
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, userId],
  );
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', 'api', $3)`,
    [projectId, orgId, userId],
  );
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, 'dev', 'dev', 'e2ee')`,
    [environmentId, projectId],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [keyId, environmentId, userId],
  );
  return { orgId, userId, environmentId, keyId };
}

/** A secret whose first version was written `days` ago. */
async function secretAt(w: World, name: string, days: number, label = name): Promise<string> {
  const id = randomUUID();
  await createSecret(t.db, {
    id,
    orgId: w.orgId,
    environmentId: w.environmentId,
    name,
    valueType: 'string',
    payload: {
      mode: 'e2ee',
      envDataKeyId: w.keyId,
      ciphertext: ascii(`xk2.gcm.${label}`),
      clientAlgorithm: 'xk2.gcm',
    },
    valueHmac: ascii(label.padEnd(32, '.')),
    writer: { userId: w.userId },
  });
  await stamp(id, 1, days);
  await t.pg.query(`update secrets set created_at = $2 where id = $1`, [id, ago(days)]);
  return id;
}

async function versionAt(w: World, secretId: string, days: number, label: string): Promise<void> {
  const { version } = await addSecretVersion(t.db, {
    orgId: w.orgId,
    secretId,
    payload: {
      mode: 'e2ee',
      envDataKeyId: w.keyId,
      ciphertext: ascii(`xk2.gcm.${label}`),
      clientAlgorithm: 'xk2.gcm',
    },
    valueHmac: ascii(label.padEnd(32, '.')),
    writer: { userId: w.userId },
  });
  await stamp(secretId, version, days);
}

async function stamp(secretId: string, version: number, days: number): Promise<void> {
  await t.pg.query(
    `update secret_versions set created_at = $3 where secret_id = $1 and version = $2`,
    [secretId, version, ago(days)],
  );
}

async function deletedAt(w: World, secretId: string, days: number): Promise<void> {
  await softDeleteSecret(t.db, w.orgId, secretId);
  await t.pg.query(`update secrets set deleted_at = $2 where id = $1`, [secretId, ago(days)]);
}

const labelOf = (material: { clientValue: { ciphertext: Uint8Array } | null }) =>
  new TextDecoder()
    .decode(material.clientValue?.ciphertext ?? new Uint8Array())
    .slice('xk2.gcm.'.length);

describe('loadEnvironmentSecretsAt', () => {
  it('answers each secret at the version current then', async () => {
    const w = await world();
    const db = await secretAt(w, 'DATABASE_URL', 10, 'db-v1');
    await versionAt(w, db, 5, 'db-v2');
    await versionAt(w, db, 1, 'db-v3');

    const atSix = await loadEnvironmentSecretsAt(t.db, w.orgId, w.environmentId, ago(6));
    expect(atSix.map((secret) => [secret.name, secret.version, labelOf(secret)])).toEqual([
      ['DATABASE_URL', 1, 'db-v1'],
    ]);

    const atTwo = await loadEnvironmentSecretsAt(t.db, w.orgId, w.environmentId, ago(2));
    expect(atTwo.map((secret) => [secret.version, labelOf(secret)])).toEqual([[2, 'db-v2']]);
  });

  it('includes a secret deleted since, and leaves out one created after', async () => {
    const w = await world();
    const gone = await secretAt(w, 'GONE', 10);
    await deletedAt(w, gone, 3);
    await secretAt(w, 'NEW', 2);

    const atFive = await loadEnvironmentSecretsAt(t.db, w.orgId, w.environmentId, ago(5));
    expect(atFive.map((secret) => secret.name)).toEqual(['GONE']);

    const atOne = await loadEnvironmentSecretsAt(t.db, w.orgId, w.environmentId, ago(1));
    expect(atOne.map((secret) => secret.name)).toEqual(['NEW']);
  });

  it('is tenant-scoped', async () => {
    const w = await world();
    const other = await world();
    await secretAt(w, 'MINE', 10);
    expect(await loadEnvironmentSecretsAt(t.db, other.orgId, w.environmentId, ago(1))).toEqual([]);
  });
});

describe('findGrantsForPrincipalOnKeys', () => {
  it('finds the principal’s grant on a retired key as well as the active one', async () => {
    const w = await world();
    const active = randomUUID();
    await t.pg.query(`update env_data_keys set status = 'retired' where id = $1`, [w.keyId]);
    await t.pg.query(
      `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 2, 'active', $3)`,
      [active, w.environmentId, w.userId],
    );
    for (const keyId of [w.keyId, active]) {
      await t.pg.query(
        `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          keyId,
          w.userId,
          ascii('xk2.x25519.e'),
          ascii('xk2.x25519.h'),
          new Uint8Array(32),
          ascii('xk2.ed25519.s'),
          w.userId,
        ],
      );
    }

    const grants = await findGrantsForPrincipalOnKeys(t.db, {
      orgId: w.orgId,
      environmentId: w.environmentId,
      envDataKeyIds: [w.keyId, active, randomUUID()],
      recipientKind: 'member',
      recipientId: w.userId,
    });
    expect([...grants.keys()].sort()).toEqual([w.keyId, active].sort());
    expect(grants.get(w.keyId)?.keyVersion).toBe(1);
  });

  it('finds nothing for another principal, or another organisation', async () => {
    const w = await world();
    const other = await world();
    const query = {
      environmentId: w.environmentId,
      envDataKeyIds: [w.keyId],
      recipientKind: 'member' as const,
    };
    expect(
      (
        await findGrantsForPrincipalOnKeys(t.db, {
          ...query,
          orgId: w.orgId,
          recipientId: other.userId,
        })
      ).size,
    ).toBe(0);
    expect(
      (
        await findGrantsForPrincipalOnKeys(t.db, {
          ...query,
          orgId: other.orgId,
          recipientId: w.userId,
        })
      ).size,
    ).toBe(0);
  });
});
