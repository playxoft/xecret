import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import type { ServiceContext } from './context';
import { createLogger } from './logging';
import type { LogEntry } from './logging';

/**
 * The nightly deleted-data purge as the Cron Trigger runs it: against a real
 * database, with WorkOS stubbed. What is erased, and what is not, is pinned
 * row by row in `@xecret/db`'s `deleted-data.test.ts`; this file pins what the
 * job adds — the audit record of each erasure, the WorkOS step, and the route
 * nobody outside the Worker can reach.
 */

const workos = vi.hoisted(() => ({
  clientId: 'client_test',
  deleteOrganization: vi.fn<(workosOrgId: string) => Promise<void>>(),
}));
vi.mock('./workos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workos')>()),
  workosProvider: () => workos,
}));

const { purgeDeletedData } = await import('./deleted-data-purge');
const { IdentityProviderUnavailableError } = await import('./workos');
const { DELETED_DATA_PURGE_PATH } = await import('./scheduled');

let t: TestDatabase;
let lines: LogEntry[] = [];

function services(): ServiceContext {
  return {
    env: {} as never,
    db: t.db,
    log: createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
    }).logger,
    meta: {
      requestId: randomUUID(),
      rayId: null,
      ipAddress: null,
      userAgent: null,
      method: 'POST',
      path: DELETED_DATA_PURGE_PATH,
      startedAt: Date.now(),
    },
    waitUntil: () => {},
  } as unknown as ServiceContext;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  workos.deleteOrganization.mockReset();
  workos.deleteOrganization.mockResolvedValue(undefined);
  lines = [];
});

const ascii = (value: string) => new TextEncoder().encode(value);

interface Org {
  orgId: string;
  userId: string;
}

async function organization(): Promise<Org> {
  const userId = randomUUID();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `user_${userId.slice(0, 8)}`, `purge-${userId.slice(0, 8)}@example.com`],
  );
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, userId],
  );
  return { orgId, userId };
}

async function project(org: Org, slug: string): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, $3, $4, $5)`,
    [id, org.orgId, slug, slug, org.userId],
  );
  return id;
}

/** An e2ee environment with its key, and one secret in it. */
async function environment(org: Org, projectId: string, slug: string) {
  const environmentId = randomUUID();
  const edkId = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, encryption_mode) values ($1, $2, $3, $4, 'e2ee')`,
    [environmentId, projectId, slug, slug],
  );
  await t.pg.query(
    `insert into env_data_keys (id, environment_id, version, status, created_by) values ($1, $2, 1, 'active', $3)`,
    [edkId, environmentId, org.userId],
  );
  const secretId = await secret(org, environmentId, edkId, 'DATABASE_URL');
  return { environmentId, edkId, secretId };
}

async function secret(org: Org, environmentId: string, edkId: string, name: string) {
  const id = randomUUID();
  await t.pg.query(
    `insert into secrets (id, environment_id, name, created_by) values ($1, $2, $3, $4)`,
    [id, environmentId, name, org.userId],
  );
  await t.pg.query(
    `insert into secret_versions (id, secret_id, version, ciphertext, env_data_key_id, client_algorithm, created_by)
     values ($1, $2, 1, $3, $4, 'xk2.gcm', $5)`,
    [randomUUID(), id, ascii('xk2.gcm.value'), edkId, org.userId],
  );
  return id;
}

async function deletedAgo(table: string, id: string, days: number): Promise<void> {
  await t.pg.query(
    `update ${table} set deleted_at = now() - make_interval(days => $2::int) where id = $1`,
    [id, days],
  );
}

async function exists(table: string, id: string): Promise<boolean> {
  const result = await t.pg.query(`select 1 from ${table} where id = $1`, [id]);
  return result.rows.length > 0;
}

interface AuditRow {
  org_id: string;
  actor_type: string;
  actor_label: string;
  action: string;
  resource_type: string;
  project_id: string | null;
  environment_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditFor(resourceId: string): Promise<AuditRow[]> {
  const result = await t.pg.query<AuditRow>(
    `select org_id, actor_type, actor_label, action, resource_type, project_id, environment_id, metadata
     from audit_logs where resource_id = $1`,
    [resourceId],
  );
  return result.rows;
}

describe('the route', () => {
  it('answers the internet 404, before building anything', async () => {
    const route = await import('@/app/api/internal/scheduled/deleted-data-purge/route');
    const outside = await route.POST(
      new Request(`https://xecret.playxoft.com${DELETED_DATA_PURGE_PATH}`, {
        method: 'POST',
        headers: { 'x-xecret-scheduled': 'a guess' },
      }),
    );
    expect(outside.status).toBe(404);
    expect(await outside.text()).toBe('');
  });
});

describe('purgeDeletedData', () => {
  it('erases what is due, files a system record for each erasure, and keeps the rest', async () => {
    // An organisation deleted 31 days ago, with a project, environment and secret.
    const gone = await organization();
    const goneEnv = await environment(gone, await project(gone, 'api'), 'production');
    await deletedAgo('organizations', gone.orgId, 31);

    // A live organisation in which a project, an environment and a secret were
    // each deleted 31 days ago, and one secret only 10 days ago.
    const live = await organization();
    const deletedProject = await project(live, 'old');
    await environment(live, deletedProject, 'dev');
    await deletedAgo('projects', deletedProject, 31);

    const keptProject = await project(live, 'web');
    const deletedEnv = await environment(live, keptProject, 'staging');
    await deletedAgo('environments', deletedEnv.environmentId, 31);

    const keptEnv = await environment(live, keptProject, 'production');
    const dueSecret = await secret(live, keptEnv.environmentId, keptEnv.edkId, 'STRIPE_KEY');
    await deletedAgo('secrets', dueSecret, 31);
    const recentSecret = await secret(live, keptEnv.environmentId, keptEnv.edkId, 'REDIS_URL');
    await deletedAgo('secrets', recentSecret, 10);

    const report = await purgeDeletedData(services());
    expect(report.failed).toBe(0);
    expect(report.organizations).toBeGreaterThanOrEqual(1);
    expect(report.projects).toBeGreaterThanOrEqual(1);
    expect(report.environments).toBeGreaterThanOrEqual(1);
    expect(report.secrets).toBeGreaterThanOrEqual(1);

    expect(await exists('organizations', gone.orgId)).toBe(false);
    expect(await exists('secrets', goneEnv.secretId)).toBe(false);
    expect(await exists('projects', deletedProject)).toBe(false);
    expect(await exists('environments', deletedEnv.environmentId)).toBe(false);
    expect(await exists('secrets', dueSecret)).toBe(false);

    expect(await exists('organizations', live.orgId)).toBe(true);
    expect(await exists('projects', keptProject)).toBe(true);
    expect(await exists('environments', keptEnv.environmentId)).toBe(true);
    expect(await exists('secrets', keptEnv.secretId)).toBe(true);
    expect(await exists('secrets', recentSecret)).toBe(true);

    const system = { actor_type: 'system', actor_label: 'deleted-data purge' };
    expect(await auditFor(gone.orgId)).toEqual([
      expect.objectContaining({
        ...system,
        org_id: gone.orgId,
        action: 'org.purged',
        resource_type: 'org',
        metadata: { environmentCount: 1, secretCount: 1, reason: '30 days since deletion' },
      }),
    ]);
    expect(await auditFor(deletedProject)).toEqual([
      expect.objectContaining({
        ...system,
        org_id: live.orgId,
        action: 'project.purged',
        project_id: deletedProject,
        metadata: {
          projectSlug: 'old',
          environmentCount: 1,
          secretCount: 1,
          reason: '30 days since deletion',
        },
      }),
    ]);
    expect(await auditFor(deletedEnv.environmentId)).toEqual([
      expect.objectContaining({
        ...system,
        org_id: live.orgId,
        action: 'environment.purged',
        project_id: keptProject,
        environment_id: deletedEnv.environmentId,
        metadata: {
          projectSlug: 'web',
          environmentSlug: 'staging',
          secretCount: 1,
          reason: '30 days since deletion',
        },
      }),
    ]);
    expect(await auditFor(dueSecret)).toEqual([
      expect.objectContaining({
        ...system,
        org_id: live.orgId,
        action: 'secret.purged',
        resource_type: 'secret',
        environment_id: keptEnv.environmentId,
        metadata: {
          secretName: 'STRIPE_KEY',
          projectSlug: 'web',
          environmentSlug: 'production',
          reason: '30 days since deletion',
        },
      }),
    ]);
    expect(await auditFor(recentSecret)).toEqual([]);
  });

  it('removes the WorkOS organisation an erased organisation’s single sign-on used', async () => {
    const org = await organization();
    await t.pg.query(
      `update organizations set workos_org_id = $2, workos_client_id = 'client_test' where id = $1`,
      [org.orgId, `org_${org.orgId.slice(0, 8)}`],
    );
    await deletedAgo('organizations', org.orgId, 31);

    await purgeDeletedData(services());
    expect(workos.deleteOrganization).toHaveBeenCalledWith(`org_${org.orgId.slice(0, 8)}`);
    expect(await exists('organizations', org.orgId)).toBe(false);
  });

  it('waits a night when WorkOS cannot be reached, rather than losing which organisation to remove', async () => {
    const org = await organization();
    await t.pg.query(
      `update organizations set workos_org_id = $2, workos_client_id = 'client_test' where id = $1`,
      [org.orgId, `org_${org.orgId.slice(0, 8)}`],
    );
    await deletedAgo('organizations', org.orgId, 31);
    workos.deleteOrganization.mockRejectedValue(
      new IdentityProviderUnavailableError('unreachable'),
    );

    const report = await purgeDeletedData(services());
    expect(report.failed).toBe(0);
    expect(await exists('organizations', org.orgId)).toBe(true);
    expect(await auditFor(org.orgId)).toEqual([]);

    // The next night WorkOS answers, and the organisation goes.
    workos.deleteOrganization.mockResolvedValue(undefined);
    await purgeDeletedData(services());
    expect(await exists('organizations', org.orgId)).toBe(false);
  });

  it('erases one linked in another WorkOS environment without asking WorkOS, and says so', async () => {
    const org = await organization();
    await t.pg.query(
      `update organizations set workos_org_id = $2, workos_client_id = 'client_other' where id = $1`,
      [org.orgId, `org_${org.orgId.slice(0, 8)}`],
    );
    await deletedAgo('organizations', org.orgId, 31);

    await purgeDeletedData(services());
    expect(workos.deleteOrganization).not.toHaveBeenCalled();
    expect(await exists('organizations', org.orgId)).toBe(false);
    expect(lines.some((line) => line.message.includes('another WorkOS environment'))).toBe(true);
  });
});
