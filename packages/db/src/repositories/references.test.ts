import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DeclaredReference } from '@xecret/core/references';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { findActiveGrantsForPrincipal } from './env-keys';
import {
  countUsableServiceTokens,
  findEnvironmentsBySlugs,
  findProjectsReferencingEnvironments,
  listChildEnvironments,
  loadEnvironmentsByIds,
  loadEnvironmentsOfProjects,
  loadSecretGraphMetadata,
  setEnvironmentParent,
} from './references';
import {
  addSecretVersion,
  createSecret,
  loadSecretsForEnvironments,
  softDeleteSecret,
} from './secrets';
import { RepositoryError } from './shared';

/**
 * The reference graph's storage (P19 §1, migration 0026), against a real
 * PostgreSQL with every migration applied.
 *
 * Two kinds of property are checked. The schema's own — a parent stays in its
 * project, never names itself, a declaration is an array, `template` is a type
 * — by issuing the statements a buggy or hostile caller would. And the
 * repository's — tenancy on every read, "current version" meaning current, a
 * revoked or expired token not counting — against rows.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

const ascii = (value: string) => new TextEncoder().encode(value);

async function attempt(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await t.pg.query(sql, params);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

interface Org {
  orgId: string;
  userId: string;
  projectId: string;
  slug: string;
}

async function org(): Promise<Org> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const projectId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `refs-${userId.slice(0, 8)}@example.com`],
  );
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, userId],
  );
  const slug = `api-${projectId.slice(0, 6)}`;
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'API', $3, $4)`,
    [projectId, orgId, slug, userId],
  );
  return { orgId, userId, projectId, slug };
}

async function project(owner: Org, slug: string): Promise<string> {
  const projectId = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, $3, $4, $5)`,
    [projectId, owner.orgId, slug, slug, owner.userId],
  );
  return projectId;
}

async function environment(
  projectId: string,
  slug: string,
  parentId: string | null = null,
): Promise<{ id: string; keyId: string }> {
  const id = randomUUID();
  const keyId = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode, parent_environment_id)
     values ($1, $2, $3, $4, 'e2ee', $5)`,
    [id, projectId, slug, slug, parentId],
  );
  const creator = await t.pg.query<{ created_by: string }>(
    `select created_by from projects where id = $1`,
    [projectId],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [keyId, id, creator.rows[0]!.created_by],
  );
  return { id, keyId };
}

function payload(keyId: string, label: string) {
  return {
    mode: 'e2ee' as const,
    envDataKeyId: keyId,
    ciphertext: ascii(`xk2.gcm.${label}`),
    clientAlgorithm: 'xk2.gcm',
  };
}

async function secret(
  owner: Org,
  env: { id: string; keyId: string },
  name: string,
  declaredReferences: DeclaredReference[] | null = null,
): Promise<string> {
  const id = randomUUID();
  await createSecret(t.db, {
    id,
    orgId: owner.orgId,
    environmentId: env.id,
    name,
    valueType: declaredReferences === null ? 'string' : 'template',
    payload: payload(env.keyId, name),
    declaredReferences,
    writer: { userId: owner.userId },
  });
  return id;
}

/* ── the schema ──────────────────────────────────────────────────────────── */

describe('migration 0026', () => {
  it('keeps a parent in the same project', async () => {
    const owner = await org();
    const other = await project(owner, `other-${randomUUID().slice(0, 6)}`);
    const here = await environment(owner.projectId, 'staging');
    const there = await environment(other, 'base');

    expect(
      await attempt(`update environments set parent_environment_id = $1 where id = $2`, [
        there.id,
        here.id,
      ]),
    ).toMatch(/environments_parent_same_project_fk/);
  });

  it('refuses an environment as its own parent', async () => {
    const owner = await org();
    const env = await environment(owner.projectId, 'loop');
    expect(
      await attempt(`update environments set parent_environment_id = id where id = $1`, [env.id]),
    ).toMatch(/environments_parent_not_self_check/);
  });

  it('refuses hard-deleting a parent a child still names', async () => {
    const owner = await org();
    const base = await environment(owner.projectId, 'base');
    await environment(owner.projectId, 'child', base.id);
    await t.pg.query(`delete from env_data_keys where environment_id = $1`, [base.id]);
    expect(await attempt(`delete from environments where id = $1`, [base.id])).toMatch(
      /environments_parent_same_project_fk/,
    );
  });

  it('accepts template as a value type, and only an array as a declaration', async () => {
    const owner = await org();
    const env = await environment(owner.projectId, 'e');
    const id = await secret(owner, env, 'URL', [{ name: 'HOST', environmentId: null }]);
    const stored = await t.pg.query<{ value_type: string }>(
      `select value_type from secrets where id = $1`,
      [id],
    );
    expect(stored.rows[0]!.value_type).toBe('template');

    expect(
      await attempt(
        `update secret_versions set declared_references = '{"a":1}' where secret_id = $1`,
        [id],
      ),
    ).toMatch(/secret_versions_declared_references_array_check/);
  });
});

/* ── reads ───────────────────────────────────────────────────────────────── */

describe('loading the graph', () => {
  it('loads a project’s live environments with their parents, and nothing of another organisation', async () => {
    const owner = await org();
    const stranger = await org();
    const base = await environment(owner.projectId, 'base');
    const child = await environment(owner.projectId, 'child', base.id);
    const gone = await environment(owner.projectId, 'gone');
    await t.pg.query(`update environments set deleted_at = now() where id = $1`, [gone.id]);
    await environment(stranger.projectId, 'theirs');

    const loaded = await loadEnvironmentsOfProjects(t.db, owner.orgId, [
      owner.projectId,
      stranger.projectId,
    ]);
    expect(loaded.map((entry) => entry.slug).sort()).toEqual(['base', 'child']);
    expect(loaded.find((entry) => entry.id === child.id)).toMatchObject({
      parentEnvironmentId: base.id,
      projectSlug: owner.slug,
      encryptionMode: 'e2ee',
    });

    expect(await loadEnvironmentsByIds(t.db, owner.orgId, [gone.id, child.id])).toHaveLength(1);
    expect(await loadEnvironmentsByIds(t.db, stranger.orgId, [child.id])).toEqual([]);
    expect(await loadEnvironmentsByIds(t.db, owner.orgId, [])).toEqual([]);
  });

  it('resolves slugs inside the organisation only', async () => {
    const owner = await org();
    const stranger = await org();
    await environment(owner.projectId, 'shared');
    await environment(stranger.projectId, 'shared');

    const found = await findEnvironmentsBySlugs(t.db, owner.orgId, [
      { projectSlug: owner.slug, environmentSlug: 'shared' },
      { projectSlug: stranger.slug, environmentSlug: 'shared' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.projectSlug).toBe(owner.slug);
    expect(await findEnvironmentsBySlugs(t.db, owner.orgId, [])).toEqual([]);
  });

  it('reads each live secret’s current declaration, and no deleted one', async () => {
    const owner = await org();
    const env = await environment(owner.projectId, 'e');
    const id = await secret(owner, env, 'URL', [{ name: 'OLD', environmentId: null }]);
    await addSecretVersion(t.db, {
      orgId: owner.orgId,
      secretId: id,
      payload: payload(env.keyId, 'v2'),
      declaredReferences: [{ name: 'NEW', environmentId: null }],
      writer: { userId: owner.userId },
    });
    const deleted = await secret(owner, env, 'DELETED');
    await softDeleteSecret(t.db, owner.orgId, deleted);

    const metadata = await loadSecretGraphMetadata(t.db, owner.orgId, [env.id]);
    expect(metadata).toEqual([
      {
        secretId: id,
        environmentId: env.id,
        name: 'URL',
        valueType: 'template',
        version: 2,
        declaredReferences: [{ name: 'NEW', environmentId: null }],
      },
    ]);
  });

  it('finds the projects whose current templates point into a set of environments', async () => {
    const owner = await org();
    const consumer = await project(owner, `consumer-${randomUUID().slice(0, 6)}`);
    const shared = await environment(owner.projectId, 'shared');
    const app = await environment(consumer, 'app');
    const stale = await environment(consumer, 'stale');

    await secret(owner, app, 'URL', [
      { environment: 'shared', name: 'HOST', environmentId: shared.id },
    ]);
    // A template that *used* to point at `shared` and no longer does.
    const moved = await secret(owner, stale, 'OLD', [
      { environment: 'shared', name: 'HOST', environmentId: shared.id },
    ]);
    await addSecretVersion(t.db, {
      orgId: owner.orgId,
      secretId: moved,
      payload: payload(stale.keyId, 'moved'),
      declaredReferences: [{ name: 'LOCAL', environmentId: null }],
      writer: { userId: owner.userId },
    });

    expect(await findProjectsReferencingEnvironments(t.db, owner.orgId, [shared.id])).toEqual([
      consumer,
    ]);
    expect(await findProjectsReferencingEnvironments(t.db, owner.orgId, [app.id])).toEqual([]);

    const stranger = await org();
    expect(await findProjectsReferencingEnvironments(t.db, stranger.orgId, [shared.id])).toEqual(
      [],
    );
  });

  it('lists children, and sets or clears a parent within the organisation', async () => {
    const owner = await org();
    const base = await environment(owner.projectId, 'base');
    const child = await environment(owner.projectId, 'child');

    await setEnvironmentParent(t.db, owner.orgId, child.id, base.id);
    expect(await listChildEnvironments(t.db, owner.orgId, base.id)).toEqual([
      { id: child.id, slug: 'child' },
    ]);

    const cleared = await setEnvironmentParent(t.db, owner.orgId, child.id, null);
    expect(cleared.parentEnvironmentId).toBeNull();
    expect(await listChildEnvironments(t.db, owner.orgId, base.id)).toEqual([]);

    const stranger = await org();
    await expect(setEnvironmentParent(t.db, stranger.orgId, child.id, null)).rejects.toThrow(
      RepositoryError,
    );
  });

  it('counts only usable service tokens', async () => {
    const owner = await org();
    const env = await environment(owner.projectId, 'ci');
    const insert = (state: 'live' | 'revoked' | 'expired' | 'future') =>
      t.pg.query(
        `insert into service_tokens (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by, revoked_at, expires_at)
         values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, $8)`,
        [
          randomUUID(),
          owner.orgId,
          owner.projectId,
          env.id,
          ascii(randomUUID()),
          owner.userId,
          state === 'revoked' ? new Date() : null,
          state === 'expired'
            ? new Date(Date.now() - 1000)
            : state === 'future'
              ? new Date(Date.now() + 86_400_000)
              : null,
        ],
      );
    await insert('live');
    await insert('revoked');
    await insert('expired');
    await insert('future');

    expect(await countUsableServiceTokens(t.db, owner.orgId, [env.id])).toBe(2);
    expect(await countUsableServiceTokens(t.db, owner.orgId, [])).toBe(0);
    const stranger = await org();
    expect(await countUsableServiceTokens(t.db, stranger.orgId, [env.id])).toBe(0);
  });
});

describe('the layered read', () => {
  it('returns every layer’s current ciphertext in one query, inside the organisation', async () => {
    const owner = await org();
    const base = await environment(owner.projectId, 'base');
    const child = await environment(owner.projectId, 'child', base.id);
    await secret(owner, base, 'A');
    await secret(owner, child, 'B', [{ name: 'A', environmentId: null }]);

    t.reset();
    const materials = await loadSecretsForEnvironments(t.db, owner.orgId, [base.id, child.id]);
    expect(t.statements).toHaveLength(1);
    expect(materials.map((material) => material.name).sort()).toEqual(['A', 'B']);
    expect(materials.find((material) => material.name === 'B')!.declaredReferences).toEqual([
      { name: 'A', environmentId: null },
    ]);

    const stranger = await org();
    expect(await loadSecretsForEnvironments(t.db, stranger.orgId, [base.id])).toEqual([]);
    expect(await loadSecretsForEnvironments(t.db, owner.orgId, [])).toEqual([]);
  });

  it('answers a principal’s grant on several environments at once', async () => {
    const owner = await org();
    const held = await environment(owner.projectId, 'held');
    const missing = await environment(owner.projectId, 'missing');
    await t.pg.query(
      `insert into env_key_grants (id, env_data_key_id, member_user_id, edk_sealed, ehk_sealed, recipient_public_key, signature, signed_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $3)`,
      [
        randomUUID(),
        held.keyId,
        owner.userId,
        ascii('xk2.x25519.edk'),
        ascii('xk2.x25519.ehk'),
        new Uint8Array(32),
        ascii('xk2.ed25519.sig'),
      ],
    );

    t.reset();
    const grants = await findActiveGrantsForPrincipal(t.db, {
      orgId: owner.orgId,
      environmentIds: [held.id, missing.id],
      recipientKind: 'member',
      recipientId: owner.userId,
    });
    expect(t.statements).toHaveLength(1);
    expect(grants.get(held.id)).toMatchObject({
      activeKey: { id: held.keyId, version: 1 },
      grant: { recipientKind: 'member', recipientId: owner.userId },
    });
    expect(grants.get(missing.id)).toEqual({
      activeKey: { id: missing.keyId, version: 1 },
      grant: null,
    });

    const stranger = await org();
    expect(
      (
        await findActiveGrantsForPrincipal(t.db, {
          orgId: stranger.orgId,
          environmentIds: [held.id],
          recipientKind: 'member',
          recipientId: owner.userId,
        })
      ).size,
    ).toBe(0);
  });
});
