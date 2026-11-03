import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import { billingCounts } from './billing';
import {
  countLiveCliDevices,
  countLiveEnvironments,
  countLiveProjects,
  countLiveServiceTokens,
  lockCapacity,
} from './capacity';
import { countSecrets } from './secrets';

/**
 * What the plan ceilings count, against real rows: only what is still live, so
 * deleting or revoking one always frees its place — and only within the scope
 * the ceiling is counted in, so one organisation's rows never spend another's.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, `cap-${id.slice(0, 8)}@example.com`],
  );
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `cap-${orgId.slice(0, 8)}`, ownerId],
  );
  return { orgId, ownerId };
}

async function seedProject(orgId: string, createdBy: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by, deleted_at) values ($1, $2, 'p', $3, $4, $5)`,
    [id, orgId, `p-${id.slice(0, 8)}`, createdBy, deleted ? new Date() : null],
  );
  return id;
}

async function seedEnvironment(projectId: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into environments (id, project_id, name, slug, deleted_at) values ($1, $2, 'e', $3, $4)`,
    [id, projectId, `e-${id.slice(0, 8)}`, deleted ? new Date() : null],
  );
  return id;
}

async function seedSecret(
  environmentId: string,
  createdBy: string,
  deleted = false,
): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into secrets (id, environment_id, name, created_by, deleted_at) values ($1, $2, $3, $4, $5)`,
    [
      id,
      environmentId,
      `S_${id.slice(0, 8).toUpperCase()}`,
      createdBy,
      deleted ? new Date() : null,
    ],
  );
  return id;
}

const hash = () => new Uint8Array(32).map(() => Math.floor(Math.random() * 256));

async function seedServiceToken(
  orgId: string,
  projectId: string,
  environmentId: string,
  createdBy: string,
  state: { revoked?: boolean; expiresIn?: string } = {},
): Promise<void> {
  await t.pg.query(
    `insert into service_tokens
       (id, org_id, project_id, environment_id, name, token_hash, token_prefix, created_by, revoked_at, expires_at)
     values ($1, $2, $3, $4, 'ci', $5, 'xst_x', $6, $7, now() + ($8)::interval)`,
    [
      randomUUID(),
      orgId,
      projectId,
      environmentId,
      hash(),
      createdBy,
      state.revoked ? new Date() : null,
      state.expiresIn ?? '100 years',
    ],
  );
}

async function seedCliToken(
  orgId: string,
  userId: string,
  state: { revoked?: boolean; expiresIn?: string | null } = {},
): Promise<void> {
  await t.pg.query(
    `insert into cli_tokens (id, user_id, org_id, name, token_hash, token_prefix, revoked_at, expires_at)
     values ($1, $2, $3, 'laptop', $4, 'xct_x', $5, now() + ($6)::interval)`,
    [
      randomUUID(),
      userId,
      orgId,
      hash(),
      state.revoked ? new Date() : null,
      state.expiresIn === undefined ? null : state.expiresIn,
    ],
  );
}

describe('the counts a plan ceiling is held to', () => {
  it('counts an organisation’s live projects, and no other organisation’s', async () => {
    const { orgId, ownerId } = await seedOrg();
    const other = await seedOrg();
    await seedProject(orgId, ownerId);
    await seedProject(orgId, ownerId);
    await seedProject(orgId, ownerId, true);
    await seedProject(other.orgId, other.ownerId);

    expect(await countLiveProjects(t.db, orgId)).toBe(2);
  });

  it('counts a project’s live environments, and none of a deleted project', async () => {
    const { orgId, ownerId } = await seedOrg();
    const project = await seedProject(orgId, ownerId);
    const sibling = await seedProject(orgId, ownerId);
    const gone = await seedProject(orgId, ownerId, true);
    await seedEnvironment(project);
    await seedEnvironment(project);
    await seedEnvironment(project, true);
    await seedEnvironment(sibling);
    await seedEnvironment(gone);

    expect(await countLiveEnvironments(t.db, orgId, project)).toBe(2);
    expect(await countLiveEnvironments(t.db, orgId, gone)).toBe(0);
    // Asked through the wrong organisation, a project has nothing.
    expect(await countLiveEnvironments(t.db, (await seedOrg()).orgId, project)).toBe(0);
  });

  it('counts an environment’s live secrets, leaving out the ones a write is about to remove', async () => {
    const { orgId, ownerId } = await seedOrg();
    const environment = await seedEnvironment(await seedProject(orgId, ownerId));
    await seedSecret(environment, ownerId);
    const removed = await seedSecret(environment, ownerId);
    await seedSecret(environment, ownerId, true);

    expect(await countSecrets(t.db, orgId, environment)).toBe(2);
    expect(await countSecrets(t.db, orgId, environment, { excluding: [removed] })).toBe(1);
    expect(await countSecrets(t.db, orgId, environment, { excluding: [] })).toBe(2);
  });

  it('counts the service tokens that can still be spent — not revoked, not expired', async () => {
    const { orgId, ownerId } = await seedOrg();
    const project = await seedProject(orgId, ownerId);
    const environment = await seedEnvironment(project);
    await seedServiceToken(orgId, project, environment, ownerId);
    await seedServiceToken(orgId, project, environment, ownerId, { expiresIn: '1 day' });
    await seedServiceToken(orgId, project, environment, ownerId, { revoked: true });
    await seedServiceToken(orgId, project, environment, ownerId, { expiresIn: '-1 minute' });

    expect(await countLiveServiceTokens(t.db, orgId)).toBe(2);
    // The billing screen warns from the same count.
    expect((await billingCounts(t.db, orgId, new Date())).serviceTokens).toBe(2);
  });

  it('counts one person’s live CLI logins in one organisation', async () => {
    const { orgId, ownerId } = await seedOrg();
    const colleague = await seedUser();
    const elsewhere = await seedOrg();
    await seedCliToken(orgId, ownerId);
    await seedCliToken(orgId, ownerId, { expiresIn: '30 days' });
    await seedCliToken(orgId, ownerId, { revoked: true });
    await seedCliToken(orgId, ownerId, { expiresIn: '-1 day' });
    await seedCliToken(orgId, colleague);
    await seedCliToken(elsewhere.orgId, ownerId);

    expect(await countLiveCliDevices(t.db, orgId, ownerId)).toBe(2);
    expect(await countLiveCliDevices(t.db, orgId, colleague)).toBe(1);
  });
});

describe('lockCapacity', () => {
  /** Advisory locks held, read on the executor — inside the transaction when given one. */
  const advisoryLocks = async (exec: Pick<typeof t.db, 'execute'>) => {
    const result = (await exec.execute(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`,
    )) as unknown as { rows: { n: number }[] };
    return result.rows[0]!.n;
  };

  it('holds a transaction-scoped lock per scope, released when the transaction ends', async () => {
    const before = await advisoryLocks(t.db);
    await t.db.transaction(async (tx) => {
      await lockCapacity(tx, 'projects', randomUUID());
      expect(await advisoryLocks(tx)).toBe(before + 1);
      await lockCapacity(tx, 'secretsPerEnvironment', randomUUID());
      expect(await advisoryLocks(tx)).toBe(before + 2);
    });
    expect(await advisoryLocks(t.db)).toBe(before);
  });
});
