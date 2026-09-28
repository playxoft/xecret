import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CUSTOM_ROLES_PER_ORGANIZATION } from '@xecret/core/validation';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  setMemberCustomRole,
  updateCustomRole,
} from './custom-roles';
import type { CustomRoleDefinition } from './custom-roles';
import { reinstateMember, removeMember, suspendMember, updateMemberRole } from './membership';
import type { MemberChange } from './membership';
import { FieldConflictError, RepositoryError } from './shared';

/**
 * The custom-role writes against a real PostgreSQL (PGlite, every migration
 * applied), for what only rows can prove: that names clash case-insensitively,
 * that the member foreign key refuses deleting a role in use and the refusal
 * is mapped under this driver — which names the constraint field `constraint`,
 * not postgres.js's `constraint_name` — that a no-op writes nothing, and that
 * a member write's guard is shown the member's custom role as the lock finds
 * it.
 *
 * The SQL shape and statement order are pinned by the recorder in
 * `custom-roles.test.ts` and `membership.test.ts`; interleavings of two
 * connections by the scratch race harness the PR describes.
 */

let t: TestDatabase;
let founderId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  founderId = await seedUser('founder');
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

/* ── fixtures ───────────────────────────────────────────────────────────── */

async function seedUser(label: string): Promise<string> {
  const id = randomUUID();
  await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
    id,
    `fb-${id}`,
    `${label}-${id.slice(0, 8)}@example.com`,
  ]);
  return id;
}

async function seedOrg(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [id, `acme-${id.slice(0, 8)}`, founderId],
  );
  return id;
}

async function seedMember(orgId: string, role: string, customRoleId: string | null = null) {
  const userId = await seedUser(role);
  const id = randomUUID();
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, custom_role_id) values ($1, $2, $3, $4, $5)`,
    [id, orgId, userId, role, customRoleId],
  );
  return id;
}

async function seedGrant(orgId: string, memberId: string, level: string): Promise<void> {
  const projectId = randomUUID();
  await t.pg.query(
    `insert into projects (id, org_id, name, slug, created_by) values ($1, $2, 'Api', $3, $4)`,
    [projectId, orgId, `api-${projectId.slice(0, 8)}`, founderId],
  );
  await t.pg.query(
    `insert into access_grants (id, org_member_id, project_id, environment_id, access_level, granted_by)
     values ($1, $2, $3, null, $4, $5)`,
    [randomUUID(), memberId, projectId, level, founderId],
  );
}

const DEPLOYER: CustomRoleDefinition = {
  name: 'Deployer',
  baseRole: 'developer',
  allowedActions: ['member.read', 'secret.read', 'secret.update'],
  accessCeiling: { nonProduction: 'write', production: 'none' },
};

async function define(orgId: string, over: Partial<CustomRoleDefinition> = {}) {
  return createCustomRole(t.db, {
    orgId,
    definition: { ...DEPLOYER, ...over },
    createdBy: founderId,
  });
}

async function storedCustomRole(memberId: string): Promise<string | null> {
  const result = await t.pg.query<{ custom_role_id: string | null }>(
    `select custom_role_id from org_members where id = $1`,
    [memberId],
  );
  return result.rows[0]?.custom_role_id ?? null;
}

/* ── names ──────────────────────────────────────────────────────────────── */

describe('role names', () => {
  it('clash case-insensitively on create, answered on the name field', async () => {
    const orgId = await seedOrg();
    await define(orgId);

    const refusal = await define(orgId, { name: 'DEPLOYER' }).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(FieldConflictError);
    expect(refusal).toMatchObject({ code: 'conflict', field: 'name' });
    expect((await listCustomRoles(t.db, orgId)).map((role) => role.name)).toEqual(['Deployer']);
  });

  it('clash case-insensitively on rename, but a role may change its own case', async () => {
    const orgId = await seedOrg();
    const deployer = await define(orgId);
    const auditor = await define(orgId, {
      name: 'Auditor',
      baseRole: 'viewer',
      allowedActions: [],
    });

    await expect(
      updateCustomRole(t.db, { orgId, roleId: auditor.id }, () => ({
        name: 'deployer',
        baseRole: 'viewer',
        allowedActions: [],
        accessCeiling: null,
      })),
    ).rejects.toMatchObject({ code: 'conflict', field: 'name' });

    const recased = await updateCustomRole(t.db, { orgId, roleId: deployer.id }, () => ({
      ...DEPLOYER,
      name: 'DEPLOYER',
    }));
    expect(recased.role.name).toBe('DEPLOYER');
  });

  it('are per organisation', async () => {
    const [first, second] = [await seedOrg(), await seedOrg()];
    await define(first);

    expect((await define(second)).name).toBe('Deployer');
  });

  it('stop at the per-organisation ceiling', async () => {
    const orgId = await seedOrg();
    for (let index = 0; index < CUSTOM_ROLES_PER_ORGANIZATION; index++) {
      await t.pg.query(
        `insert into custom_roles (id, org_id, name, base_role) values ($1, $2, $3, 'viewer')`,
        [randomUUID(), orgId, `Role ${index}`],
      );
    }

    await expect(define(orgId, { name: 'One too many' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

/* ── deleting, and the foreign key under this driver ──────────────────────── */

describe('deleting a role', () => {
  it('is refused while anybody holds it — the foreign key, mapped from `constraint`', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);
    await seedMember(orgId, 'developer', role.id);

    const refusal = await deleteCustomRole(t.db, { orgId, roleId: role.id }, () => {}).catch(
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(RepositoryError);
    expect(refusal).toMatchObject({ code: 'conflict' });
    expect((refusal as Error).message).toMatch(/still held by members/);
  });

  it('deletes a role nobody holds', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);

    await deleteCustomRole(t.db, { orgId, roleId: role.id }, () => {});

    expect(await listCustomRoles(t.db, orgId)).toEqual([]);
  });
});

/* ── no-ops ─────────────────────────────────────────────────────────────── */

describe('a change that changes nothing', () => {
  it('writes nothing for an edit decide finds unchanged — not even updated_at', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);

    const result = await updateCustomRole(t.db, { orgId, roleId: role.id }, () => null);

    expect(result.changed).toBe(false);
    const [stored] = await listCustomRoles(t.db, orgId);
    expect(stored?.updatedAt).toEqual(role.updatedAt);
  });

  it('writes nothing, and asks no guard, for the role a member already holds', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);
    const memberId = await seedMember(orgId, 'developer', role.id);
    const before = await t.pg.query<{ updated_at: Date }>(
      `select updated_at from org_members where id = $1`,
      [memberId],
    );
    let asked = false;

    const change = await setMemberCustomRole(
      t.db,
      { orgId, memberId, customRoleId: role.id },
      () => {
        asked = true;
      },
    );

    expect(change.changed).toBe(false);
    expect(asked).toBe(false);
    const after = await t.pg.query<{ updated_at: Date }>(
      `select updated_at from org_members where id = $1`,
      [memberId],
    );
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
  });
});

/* ── the member writes' guard ───────────────────────────────────────────── */

describe('a member write shows its guard the member as it finds them', () => {
  const writes = {
    'a role change': (orgId: string, memberId: string, guard: (change: MemberChange) => void) =>
      updateMemberRole(t.db, { orgId, memberId, role: 'admin' }, guard),
    'a suspension': (orgId: string, memberId: string, guard: (change: MemberChange) => void) =>
      suspendMember(t.db, { orgId, memberId }, guard),
    'a reinstatement': (orgId: string, memberId: string, guard: (change: MemberChange) => void) =>
      reinstateMember(t.db, { orgId, memberId }, guard),
    'a removal': (orgId: string, memberId: string, guard: (change: MemberChange) => void) =>
      removeMember(t.db, { orgId, memberId }, guard),
  };

  it.each(Object.entries(writes))(
    'shows %s the custom role and grants the member holds now',
    async (_name, write) => {
      const orgId = await seedOrg();
      const role = await define(orgId);
      const memberId = await seedMember(orgId, 'developer', role.id);
      await seedGrant(orgId, memberId, 'write');
      const seen: MemberChange[] = [];

      await write(orgId, memberId, (change) => void seen.push(change));

      expect(seen).toHaveLength(1);
      expect(seen[0]?.member.customRole?.name).toBe('Deployer');
      expect(seen[0]?.member.customRole?.accessCeiling).toEqual({
        nonProduction: 'write',
        production: 'none',
      });
      expect(seen[0]?.grants.map((grant) => grant.accessLevel)).toEqual(['write']);
    },
  );

  it('sees an unassignment that committed after the route last read the member', async () => {
    // What a stale route read would have missed: by the time the role change
    // takes the lock, the member no longer holds the custom role.
    const orgId = await seedOrg();
    const role = await define(orgId);
    const memberId = await seedMember(orgId, 'viewer', role.id);
    await setMemberCustomRole(t.db, { orgId, memberId, customRoleId: null }, () => {});
    const seen: MemberChange[] = [];

    await updateMemberRole(t.db, { orgId, memberId, role: 'developer' }, (change) => {
      seen.push(change);
    });

    expect(seen[0]?.member.customRole).toBeUndefined();
  });

  it('writes nothing when the guard refuses', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);
    const memberId = await seedMember(orgId, 'developer', role.id);

    await expect(
      updateMemberRole(t.db, { orgId, memberId, role: 'admin' }, () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');

    const result = await t.pg.query<{ role: string }>(
      `select role from org_members where id = $1`,
      [memberId],
    );
    expect(result.rows[0]?.role).toBe('developer');
  });

  it('clears the custom role a promotion to owner drops, and reports it', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);
    const memberId = await seedMember(orgId, 'admin', role.id);

    const result = await updateMemberRole(t.db, { orgId, memberId, role: 'owner' }, () => {});

    expect(result.clearedCustomRole).toEqual({ id: role.id, name: 'Deployer' });
    expect(await storedCustomRole(memberId)).toBeNull();
  });
});

describe('assigning', () => {
  it('refuses an owner before the CHECK has to, and leaves the row alone', async () => {
    const orgId = await seedOrg();
    const role = await define(orgId);
    const ownerId = await seedMember(orgId, 'owner');

    await expect(
      setMemberCustomRole(t.db, { orgId, memberId: ownerId, customRoleId: role.id }, () => {}),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await storedCustomRole(ownerId)).toBeNull();
  });

  it('refuses another organisation’s role as not found', async () => {
    const [orgId, otherOrgId] = [await seedOrg(), await seedOrg()];
    const theirs = await define(otherOrgId);
    const memberId = await seedMember(orgId, 'developer');

    await expect(
      setMemberCustomRole(t.db, { orgId, memberId, customRoleId: theirs.id }, () => {}),
    ).rejects.toMatchObject({ code: 'notFound' });
  });
});
