import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveEntitlements } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  DELETED_DATA_RETENTION_DAYS,
  deletedSecretRetentionDays,
  listEnvironmentsDueForPurge,
  listOrganizationsDueForPurge,
  listOrganizationsWithDeletedSecrets,
  listProjectsDueForPurge,
  purgeDeletedSecrets,
  purgeEnvironment,
  purgeOrganization,
  purgeProject,
} from './deleted-data';
import { createVault, resetVault } from './vault';

/**
 * The deleted-data purge, against real rows, real foreign keys and the real
 * retained-vault triggers.
 *
 * "Erased" is checked the only way that means anything: by counting what is
 * left, table by table, for the ids the fixture created — including the key
 * tables whose `RESTRICT` the purge has to work around rather than through.
 *
 * Deletion times are written by hand (`now() - N days`), and every cutoff is
 * the database's own clock, so "31 days ago" is exactly that to the code under
 * test.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const ascii = (value: string) => new TextEncoder().encode(value);
const filled = (length: number, value: number) => new Uint8Array(length).fill(value);

interface World {
  userId: string;
  orgId: string;
  orgKeyId: string;
  projectId: string;
  /** Server-envelope: an `env_keys` row under the org key. */
  serverEnvId: string;
  /** End-to-end: an EDK, an EHK and the owner's grant. */
  e2eeEnvId: string;
  edkId: string;
  serverSecretId: string;
  e2eeSecretId: string;
}

async function account(): Promise<string> {
  const userId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `purge-${userId.slice(0, 8)}@example.com`],
  );
  return userId;
}

/** An organisation with one project, one environment of each kind, and one secret in each. */
async function world(userId?: string): Promise<World> {
  const owner = userId ?? (await account());
  const orgId = randomUUID();
  const orgKeyId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, owner],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, owner],
  );
  await t.pg.query(
    `insert into org_keys (id, org_id, version, wrapped_key, wrap_iv, root_key_version)
     values ($1, $2, 1, $3, $4, 1)`,
    [orgKeyId, orgId, ascii('wrapped-omk'), filled(12, 1)],
  );
  const { projectId, serverEnvId, e2eeEnvId, edkId, serverSecretId, e2eeSecretId } = await project(
    orgId,
    orgKeyId,
    owner,
    'api',
  );
  return {
    userId: owner,
    orgId,
    orgKeyId,
    projectId,
    serverEnvId,
    e2eeEnvId,
    edkId,
    serverSecretId,
    e2eeSecretId,
  };
}

async function project(orgId: string, orgKeyId: string, userId: string, slug: string) {
  const projectId = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', $3, $4)`,
    [projectId, orgId, slug, userId],
  );

  const serverEnvId = await environment(projectId, 'legacy', 'server');
  const envKeyId = randomUUID();
  await t.pg.query(
    `insert into env_keys (id, environment_id, org_key_id, version, wrapped_key, wrap_iv)
     values ($1, $2, $3, 1, $4, $5)`,
    [envKeyId, serverEnvId, orgKeyId, ascii('wrapped-edk'), filled(12, 2)],
  );
  const serverSecretId = await secret(serverEnvId, 'DATABASE_URL', userId, { envKeyId });

  const e2eeEnvId = await environment(projectId, 'production', 'e2ee');
  const edkId = randomUUID();
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [edkId, e2eeEnvId, userId],
  );
  await t.pg.query(
    `insert into env_hmac_keys (id, environment_id, created_by) values ($1, $2, $3)`,
    [randomUUID(), e2eeEnvId, userId],
  );
  await grant(edkId, userId);
  const e2eeSecretId = await secret(e2eeEnvId, 'STRIPE_KEY', userId, { envDataKeyId: edkId });

  return { projectId, serverEnvId, e2eeEnvId, edkId, serverSecretId, e2eeSecretId };
}

async function environment(projectId: string, slug: string, mode: 'server' | 'e2ee') {
  const id = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, $3, $4, $5)`,
    [id, projectId, slug, slug, mode],
  );
  return id;
}

/** A secret with two versions under the given key. */
async function secret(
  environmentId: string,
  name: string,
  userId: string,
  key: { envKeyId: string } | { envDataKeyId: string },
): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into secrets (id, environment_id, name, created_by) values ($1, $2, $3, $4)`,
    [id, environmentId, name, userId],
  );
  for (const version of [1, 2]) {
    if ('envKeyId' in key) {
      await t.pg.query(
        `insert into secret_versions (id, secret_id, version, ciphertext, iv, env_key_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), id, version, ascii(`ct-${version}`), filled(12, 3), key.envKeyId, userId],
      );
    } else {
      await t.pg.query(
        `insert into secret_versions (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, created_by)
         values ($1, $2, $3, $4, $5, 'xk2.gcm', $6)`,
        [randomUUID(), id, version, ascii(`xk2.gcm.${version}`), key.envDataKeyId, userId],
      );
    }
  }
  return id;
}

async function grant(envDataKeyId: string, userId: string): Promise<void> {
  await t.pg.query(
    `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $3)`,
    [
      randomUUID(),
      envDataKeyId,
      userId,
      ascii('xk2.x25519.edk'),
      ascii('xk2.x25519.ehk'),
      filled(32, 7),
      ascii('xk2.ed25519.sig'),
    ],
  );
}

type Deletable = 'organizations' | 'projects' | 'environments' | 'secrets';

/** Marks a row deleted `days` ago, by the database's clock. */
async function deletedAgo(table: Deletable, id: string, days: number): Promise<void> {
  await t.pg.query(
    `update ${table} set deleted_at = now() - make_interval(days => $2::int) where id = $1`,
    [id, days],
  );
}

async function rows(sql: string, params: unknown[]): Promise<number> {
  const result = await t.pg.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params);
  return result.rows[0]!.n;
}

/** Everything the fixture created for `w`, counted table by table. */
async function remaining(w: World) {
  return {
    organization: await rows(`organizations where id = $1`, [w.orgId]),
    members: await rows(`org_members where org_id = $1`, [w.orgId]),
    orgKeys: await rows(`org_keys where org_id = $1`, [w.orgId]),
    projects: await rows(`projects where org_id = $1`, [w.orgId]),
    environments: await rows(`environments where id = any($1::uuid[])`, [
      [w.serverEnvId, w.e2eeEnvId],
    ]),
    envKeys: await rows(`env_keys where environment_id = $1`, [w.serverEnvId]),
    envDataKeys: await rows(`env_data_keys where environment_id = $1`, [w.e2eeEnvId]),
    envHmacKeys: await rows(`env_hmac_keys where environment_id = $1`, [w.e2eeEnvId]),
    grants: await rows(`env_key_grants where env_data_key_id = $1`, [w.edkId]),
    secrets: await rows(`secrets where id = any($1::uuid[])`, [[w.serverSecretId, w.e2eeSecretId]]),
    versions: await rows(`secret_versions where secret_id = any($1::uuid[])`, [
      [w.serverSecretId, w.e2eeSecretId],
    ]),
  };
}

const UNTOUCHED = {
  organization: 1,
  members: 1,
  orgKeys: 1,
  projects: 1,
  environments: 2,
  envKeys: 1,
  envDataKeys: 1,
  envHmacKeys: 1,
  grants: 1,
  secrets: 2,
  versions: 4,
};

const ERASED = {
  organization: 0,
  members: 0,
  orgKeys: 0,
  projects: 0,
  environments: 0,
  envKeys: 0,
  envDataKeys: 0,
  envHmacKeys: 0,
  grants: 0,
  secrets: 0,
  versions: 0,
};

describe('the retention', () => {
  it('is thirty days, or a plan’s restore window when that is longer', () => {
    expect(DELETED_DATA_RETENTION_DAYS).toBe(30);
    const on = (plan: 'free' | 'pro' | 'team' | 'enterprise') =>
      deletedSecretRetentionDays(
        resolveEntitlements({
          plan,
          status: 'active',
          addonSaml: false,
          addonDirectorySync: false,
        }),
      );
    expect(on('free')).toBe(30);
    expect(on('pro')).toBe(30);
    expect(on('team')).toBe(180);
    expect(on('enterprise')).toBe(365);
  });

  it('refuses a secret purge shorter than thirty days', async () => {
    const w = await world();
    await expect(
      purgeDeletedSecrets(t.db, { orgId: w.orgId, retentionDays: 29, limit: 10 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('organisations', () => {
  it('erases one deleted 31 days ago, with everything in it, and keeps one deleted 29 days ago', async () => {
    const due = await world();
    const recent = await world();
    const live = await world();
    await deletedAgo('organizations', due.orgId, 31);
    await deletedAgo('organizations', recent.orgId, 29);

    const listed = (await listOrganizationsDueForPurge(t.db, 1000)).map((org) => org.id);
    expect(listed).toContain(due.orgId);
    expect(listed).not.toContain(recent.orgId);
    expect(listed).not.toContain(live.orgId);

    let recorded: unknown = null;
    const purged = await purgeOrganization(t.db, due.orgId, async (_tx, row) => {
      recorded = row;
    });
    expect(purged).toMatchObject({
      id: due.orgId,
      projectCount: 1,
      environmentCount: 2,
      secretCount: 2,
    });
    expect(recorded).toEqual(purged);

    expect(await remaining(due)).toEqual(ERASED);
    expect(await remaining(recent)).toEqual(UNTOUCHED);
    expect(await remaining(live)).toEqual(UNTOUCHED);
  });

  it('does nothing to an organisation that is not deleted, or not deleted long enough', async () => {
    const live = await world();
    const recent = await world();
    await deletedAgo('organizations', recent.orgId, 29);

    expect(await purgeOrganization(t.db, live.orgId)).toBeNull();
    expect(await purgeOrganization(t.db, recent.orgId)).toBeNull();
    expect(await remaining(live)).toEqual(UNTOUCHED);
    expect(await remaining(recent)).toEqual(UNTOUCHED);
  });

  it('erases projects and secrets that were deleted inside it before it was', async () => {
    const w = await world();
    await deletedAgo('secrets', w.serverSecretId, 40);
    await deletedAgo('environments', w.e2eeEnvId, 35);
    await deletedAgo('organizations', w.orgId, 31);

    expect(await purgeOrganization(t.db, w.orgId)).not.toBeNull();
    expect(await remaining(w)).toEqual(ERASED);
  });

  it('leaves every audit record filed against it exactly as it was', async () => {
    const w = await world();
    const recordId = randomUUID();
    await t.pg.query(
      `insert into audit_logs (id, org_id, actor_type, actor_label, action, outcome, metadata)
       values ($1, $2, 'user', 'owner@example.com', 'org.deleted', 'success', '{}')`,
      [recordId, w.orgId],
    );
    await deletedAgo('organizations', w.orgId, 31);

    expect(await purgeOrganization(t.db, w.orgId)).not.toBeNull();
    expect(await rows(`audit_logs where id = $1 and org_id = $2`, [recordId, w.orgId])).toBe(1);
  });

  it('waits while the payment provider still bills it, and goes once the subscription has ended', async () => {
    const w = await world();
    await deletedAgo('organizations', w.orgId, 31);
    await t.pg.query(
      `insert into org_subscriptions (org_id, plan, billing_interval, dodo_subscription_id, dodo_product_id, cancel_at_period_end)
       values ($1, 'pro', 'yearly', $2, 'pdt_pro_y', true)`,
      [w.orgId, `sub_${w.orgId.slice(0, 8)}`],
    );

    expect((await listOrganizationsDueForPurge(t.db, 1000)).map((org) => org.id)).not.toContain(
      w.orgId,
    );
    expect(await purgeOrganization(t.db, w.orgId)).toBeNull();
    expect(await remaining(w)).toEqual(UNTOUCHED);

    // What the hourly billing job writes when the cancelled period ends.
    await t.pg.query(
      `update org_subscriptions set plan = 'free', billing_interval = null where org_id = $1`,
      [w.orgId],
    );
    expect(await purgeOrganization(t.db, w.orgId)).not.toBeNull();
    expect(await rows(`org_subscriptions where org_id = $1`, [w.orgId])).toBe(0);
  });

  it('waits for a reset vault inside its seven days that holds one of its keys', async () => {
    const userId = await account();
    const w = await world(userId);
    await createVault(t.db, {
      userId,
      encAlgorithm: 'X25519',
      encPublicKey: filled(32, 9),
      encPrivateKeyEnc: ascii('xk2.gcm.enc'),
      signAlgorithm: 'Ed25519',
      signPublicKey: filled(32, 9),
      signPrivateKeyEnc: ascii('xk2.gcm.sign'),
      kdfSalt: filled(16, 9),
      kdfParams: { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 },
      unlockVerifierHash: filled(32, 9),
      ukUnlockVerifierHash: filled(32, 59),
      passphraseWrap: ascii('xk2.gcm.passphrase'),
      recoveryWraps: [{ lookupHash: new Uint8Array(randomBytes(32)), wrap: ascii('xk2.gcm.r') }],
    });
    // Moves the owner's grant on the e2ee environment's key into the retained vault.
    await resetVault(t.db, userId);
    expect(await rows(`retained_vault_grants where env_data_key_id = $1`, [w.edkId])).toBe(1);
    await deletedAgo('organizations', w.orgId, 31);

    expect((await listOrganizationsDueForPurge(t.db, 1000)).map((org) => org.id)).not.toContain(
      w.orgId,
    );
    expect(await purgeOrganization(t.db, w.orgId)).toBeNull();
    expect(await rows(`organizations where id = $1`, [w.orgId])).toBe(1);
  });
});

describe('projects', () => {
  it('erases a project deleted 31 days ago and nothing else in its organisation', async () => {
    const w = await world();
    const other = await project(w.orgId, w.orgKeyId, w.userId, 'web');
    await deletedAgo('projects', other.projectId, 31);
    const recent = await project(w.orgId, w.orgKeyId, w.userId, 'jobs');
    await deletedAgo('projects', recent.projectId, 29);

    const listed = await listProjectsDueForPurge(t.db, 1000);
    expect(listed).toContain(other.projectId);
    expect(listed).not.toContain(recent.projectId);
    expect(listed).not.toContain(w.projectId);

    expect(await purgeProject(t.db, other.projectId)).toMatchObject({
      id: other.projectId,
      orgId: w.orgId,
      slug: 'web',
      environmentCount: 2,
      secretCount: 2,
    });
    expect(await rows(`projects where id = $1`, [other.projectId])).toBe(0);
    expect(await rows(`environments where project_id = $1`, [other.projectId])).toBe(0);
    expect(await rows(`env_data_keys where id = $1`, [other.edkId])).toBe(0);
    expect(
      await rows(`secrets where id = any($1::uuid[])`, [
        [other.serverSecretId, other.e2eeSecretId],
      ]),
    ).toBe(0);

    // The organisation, its key, and its other projects are exactly as they were.
    expect(await remaining(w)).toEqual({ ...UNTOUCHED, projects: 2 });
    expect(await rows(`projects where id = $1`, [recent.projectId])).toBe(1);
    expect(await purgeProject(t.db, recent.projectId)).toBeNull();
    expect(await purgeProject(t.db, w.projectId)).toBeNull();
  });
});

describe('environments', () => {
  it('erases an environment deleted 31 days ago, keeps its sibling and its project', async () => {
    const w = await world();
    await deletedAgo('environments', w.e2eeEnvId, 31);

    expect(await listEnvironmentsDueForPurge(t.db, 1000)).toContain(w.e2eeEnvId);
    expect(await purgeEnvironment(t.db, w.e2eeEnvId)).toMatchObject({
      id: w.e2eeEnvId,
      orgId: w.orgId,
      projectId: w.projectId,
      projectSlug: 'api',
      slug: 'production',
      secretCount: 1,
    });

    expect(await remaining(w)).toEqual({
      ...UNTOUCHED,
      environments: 1,
      envDataKeys: 0,
      envHmacKeys: 0,
      grants: 0,
      secrets: 1,
      versions: 2,
    });
  });

  it('waits while another environment still names it as its parent', async () => {
    const w = await world();
    await t.pg.query(`update environments set parent_environment_id = $1 where id = $2`, [
      w.e2eeEnvId,
      w.serverEnvId,
    ]);
    await deletedAgo('environments', w.e2eeEnvId, 31);

    expect(await listEnvironmentsDueForPurge(t.db, 1000)).not.toContain(w.e2eeEnvId);
    expect(await purgeEnvironment(t.db, w.e2eeEnvId)).toBeNull();

    // Once the child has gone, the parent follows.
    await deletedAgo('environments', w.serverEnvId, 32);
    expect(await purgeEnvironment(t.db, w.serverEnvId)).not.toBeNull();
    expect(await purgeEnvironment(t.db, w.e2eeEnvId)).not.toBeNull();
    expect(await remaining(w)).toMatchObject({ environments: 0, secrets: 0, projects: 1 });
  });
});

describe('secrets', () => {
  it('erases a secret deleted 31 days ago with its versions, and keeps the rest', async () => {
    const w = await world();
    const recent = await secret(w.serverEnvId, 'REDIS_URL', w.userId, {
      envKeyId: (
        await t.pg.query<{ id: string }>(`select id from env_keys where environment_id = $1`, [
          w.serverEnvId,
        ])
      ).rows[0]!.id,
    });
    await deletedAgo('secrets', w.serverSecretId, 31);
    await deletedAgo('secrets', recent, 29);

    const orgs = await listOrganizationsWithDeletedSecrets(t.db, { limit: 1000 });
    expect(orgs).toContainEqual({ orgId: w.orgId, retentionDays: 30 });

    let recorded: readonly unknown[] = [];
    const purged = await purgeDeletedSecrets(
      t.db,
      { orgId: w.orgId, retentionDays: 30, limit: 10 },
      async (_tx, rows) => {
        recorded = rows;
      },
    );
    expect(purged).toEqual([
      {
        id: w.serverSecretId,
        name: 'DATABASE_URL',
        environmentId: w.serverEnvId,
        environmentSlug: 'legacy',
        projectId: w.projectId,
        projectSlug: 'api',
      },
    ]);
    expect(recorded).toEqual(purged);

    expect(await rows(`secrets where id = $1`, [w.serverSecretId])).toBe(0);
    expect(await rows(`secret_versions where secret_id = $1`, [w.serverSecretId])).toBe(0);
    expect(await rows(`secrets where id = any($1::uuid[])`, [[recent, w.e2eeSecretId]])).toBe(2);
    // The environment and its key are still in use.
    expect(await rows(`env_keys where environment_id = $1`, [w.serverEnvId])).toBe(1);
  });

  it('keeps a Team organisation’s deleted secrets for its 180-day restore window', async () => {
    const w = await world();
    await t.pg.query(
      `insert into org_subscriptions (org_id, plan, billing_interval) values ($1, 'team', 'monthly')`,
      [w.orgId],
    );
    await deletedAgo('secrets', w.serverSecretId, 31);
    await deletedAgo('secrets', w.e2eeSecretId, 181);

    const orgs = await listOrganizationsWithDeletedSecrets(t.db, { limit: 1000 });
    const entry = orgs.find((org) => org.orgId === w.orgId);
    expect(entry).toEqual({ orgId: w.orgId, retentionDays: 180 });

    const purged = await purgeDeletedSecrets(t.db, {
      orgId: w.orgId,
      retentionDays: entry!.retentionDays,
      limit: 10,
    });
    expect(purged.map((row) => row.id)).toEqual([w.e2eeSecretId]);
    expect(await rows(`secrets where id = $1`, [w.serverSecretId])).toBe(1);
  });

  it('pages organisations in id order', async () => {
    const a = await world();
    const b = await world();
    await deletedAgo('secrets', a.serverSecretId, 31);
    await deletedAgo('secrets', b.serverSecretId, 31);
    const [first, second] = [a.orgId, b.orgId].sort();

    const all = (await listOrganizationsWithDeletedSecrets(t.db, { limit: 1000 })).map(
      (org) => org.orgId,
    );
    expect(all.indexOf(first!)).toBeLessThan(all.indexOf(second!));
    const after = (
      await listOrganizationsWithDeletedSecrets(t.db, { limit: 1000, afterOrgId: first! })
    ).map((org) => org.orgId);
    expect(after).not.toContain(first);
    expect(after).toContain(second);
  });

  it('touches no other organisation’s secrets', async () => {
    const mine = await world();
    const theirs = await world();
    await deletedAgo('secrets', theirs.serverSecretId, 31);

    expect(
      await purgeDeletedSecrets(t.db, { orgId: mine.orgId, retentionDays: 30, limit: 10 }),
    ).toEqual([]);
    expect(await rows(`secrets where id = $1`, [theirs.serverSecretId])).toBe(1);
  });
});
