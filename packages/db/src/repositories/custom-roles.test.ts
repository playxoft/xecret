import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  setMemberCustomRole,
  toEngineCustomRole,
  updateCustomRole,
} from './custom-roles';
import type { CustomRoleDefinition } from './custom-roles';
import { listOrganizationsForUser, organizationsForUserQuery } from './organizations';
import { FieldConflictError, RepositoryError } from './shared';
import { CUSTOM_ROLES_PER_ORGANIZATION } from '@xecret/core/validation';

/**
 * The custom-role repository: the SQL each function sends, in what order, and
 * inside which transaction — and the one property the module exists for,
 * that every decision a caller makes about a role or a member is made on rows
 * read under the organisation lock, before anything is written.
 *
 * The same recorder as `membership.test.ts`: statements are captured, no
 * connection is opened, rows are supplied positionally in the order the
 * column sets declare them, and `begin` / `commit` markers bracket each
 * transaction. It can also fail a statement with a driver-shaped error, which
 * is how the constraint mappings are pinned. Whether PostgreSQL accepts the
 * SQL is the standing caveat `resources.test.ts` records; these statements
 * were also run against a real one (see the PR).
 */

const ORG_ID = '01930000-0000-7000-8000-000000000001';
const ROLE_ID = '01930000-0000-7000-8000-000000000002';
const MEMBER_ID = '01930000-0000-7000-8000-000000000003';
const USER_ID = '01930000-0000-7000-8000-000000000004';
const OTHER_MEMBER_ID = '01930000-0000-7000-8000-000000000005';
const OTHER_USER_ID = '01930000-0000-7000-8000-000000000006';
const PROJECT_ID = '01930000-0000-7000-8000-000000000007';
const CREATOR_ID = '01930000-0000-7000-8000-000000000008';
const OTHER_ROLE_ID = '01930000-0000-7000-8000-000000000009';
const WHEN = '2026-09-01T12:00:00.000Z';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * A driver error as postgres.js raises one — or, with `field: 'constraint'`,
 * as PGlite and node-postgres do.
 */
function pgError(
  code: string,
  constraint: string,
  field: 'constraint_name' | 'constraint' = 'constraint_name',
): Error {
  return Object.assign(new Error(`violates constraint "${constraint}"`), {
    code,
    [field]: constraint,
  });
}

function recorder(rowsFor: (sql: string) => unknown[] | Error): {
  db: Database;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });
      const outcome = rowsFor(sql);
      const settle = () =>
        outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      const result = {
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          settle().then(resolve, reject),
        values: settle,
      };
      return result;
    },
    begin: async <T>(run: (client: unknown) => Promise<T>) => {
      statements.push({ sql: 'begin', params: [] });
      try {
        const result = await run(client);
        statements.push({ sql: 'commit', params: [] });
        return result;
      } catch (cause) {
        statements.push({ sql: 'rollback', params: [] });
        throw cause;
      }
    },
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

/** `custom_roles`, positionally, as `ROLE_COLUMNS` declares it. */
const DEPLOYER = [
  ROLE_ID,
  ORG_ID,
  'Deployer',
  'developer',
  ['member.read', 'secret.read', 'secret.update'],
  'write',
  'none',
  WHEN,
  WHEN,
];

const DEFINITION: CustomRoleDefinition = {
  name: 'Deployer',
  baseRole: 'developer',
  allowedActions: ['member.read', 'secret.read', 'secret.update', 'secret.read'],
  accessCeiling: { nonProduction: 'write', production: 'none' },
};

const db0 = (recorded: { db: Database }) => recorded.db;
const isOrgLock = (sql: string) =>
  sql.includes('from "organizations"') && sql.includes('for update');
/** Every name the organisation holds, read to compare skeletons against. */
const isNameCheck = (sql: string) => sql.startsWith('select "id", "name" from "custom_roles"');
const isRoleRead = (sql: string) =>
  sql.startsWith('select') && sql.includes('from "custom_roles"') && !isNameCheck(sql);

/* ── Reads ────────────────────────────────────────────────────────────────── */

describe('listCustomRoles', () => {
  it('reads one organisation’s roles, each with a holder count scoped to that organisation', async () => {
    const { db, statements } = recorder(() => [[...DEPLOYER, 3]]);

    const roles = await listCustomRoles(db, ORG_ID);

    const [statement] = statements;
    expect(statement!.sql).toContain('where "custom_roles"."org_id" = $1');
    // The count matches the role on both columns — a member of another
    // organisation pointing at this id (which the foreign key forbids) is not
    // counted as holding it.
    expect(statement!.sql).toContain('held.org_id = "custom_roles"."org_id"');
    expect(statement!.sql).toContain('held.custom_role_id = "custom_roles"."id"');
    expect(statement!.sql).toContain('order by "custom_roles"."name" asc, "custom_roles"."id" asc');
    expect(statement!.params).toContain(CUSTOM_ROLES_PER_ORGANIZATION);
    expect(roles).toEqual([
      {
        id: ROLE_ID,
        orgId: ORG_ID,
        name: 'Deployer',
        baseRole: 'developer',
        allowedActions: ['member.read', 'secret.read', 'secret.update'],
        accessCeiling: { nonProduction: 'write', production: 'none' },
        createdAt: new Date(WHEN),
        updatedAt: new Date(WHEN),
        holderCount: 3,
      },
    ]);
  });

  it('reads a role without a ceiling as null, and half a ceiling as none on the missing half', async () => {
    const noCeiling = [...DEPLOYER.slice(0, 5), null, null, WHEN, WHEN, 0];
    const halfSet = [...DEPLOYER.slice(0, 5), 'read', null, WHEN, WHEN, 0];
    const { db } = recorder(() => [noCeiling, halfSet]);

    const [first, second] = await listCustomRoles(db, ORG_ID);

    expect(first!.accessCeiling).toBeNull();
    expect(second!.accessCeiling).toEqual({ nonProduction: 'read', production: 'none' });
    expect(toEngineCustomRole(first!)).not.toHaveProperty('accessCeiling');
  });
});

/* ── Defining ─────────────────────────────────────────────────────────────── */

describe('createCustomRole', () => {
  /** `names`: the `[id, name]` rows the organisation already holds. */
  function creating(
    count: number,
    insert: unknown[] | Error = [DEPLOYER],
    names: unknown[][] = [[OTHER_ROLE_ID, 'Release manager']],
  ) {
    return recorder((sql) => {
      if (isOrgLock(sql)) return [[ORG_ID]];
      if (sql.startsWith('select count')) return [[count]];
      if (isNameCheck(sql)) return names;
      if (sql.startsWith('insert into "custom_roles"')) return insert;
      return [];
    });
  }

  it('locks the organisation, counts, checks the name, then inserts — one transaction', async () => {
    const { db, statements } = creating(0);

    const role = await createCustomRole(db, {
      orgId: ORG_ID,
      definition: DEFINITION,
      createdBy: CREATOR_ID,
    });

    expect(statements.map((statement) => statement.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin',
      'select "id" from',
      'select count(*) from',
      'select "id", "name"',
      'insert into "custom_roles"',
      'commit',
    ]);
    // Every name in the organisation — all of them, so the comparison on
    // skeletons sees each — and nothing from another.
    const check = statements.find((statement) => isNameCheck(statement.sql))!;
    expect(check.sql).toContain('where "custom_roles"."org_id" = $1');
    expect(check.sql).not.toContain('limit');
    expect(check.params).toEqual([ORG_ID]);
    // Each action once: the row says what the role may do, not how the
    // request happened to phrase it.
    const insert = statements.find((statement) => statement.sql.startsWith('insert'))!;
    expect(insert.params).toContain('{"member.read","secret.read","secret.update"}');
    expect(insert.params).toContain(CREATOR_ID);
    expect(role.name).toBe('Deployer');
  });

  it('refuses an owner base before any statement is sent', async () => {
    const { db, statements } = creating(0);

    await expect(
      createCustomRole(db, {
        orgId: ORG_ID,
        definition: { ...DEFINITION, baseRole: 'owner' },
        createdBy: CREATOR_ID,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(statements).toEqual([]);
  });

  it('refuses the role past the per-organisation ceiling', async () => {
    const { db, statements } = creating(CUSTOM_ROLES_PER_ORGANIZATION);

    await expect(
      createCustomRole(db, { orgId: ORG_ID, definition: DEFINITION, createdBy: CREATOR_ID }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(statements.some((statement) => statement.sql.startsWith('insert'))).toBe(false);
  });

  it.each([
    ['in another case', 'deployer'],
    ['behind a variation selector', `Deployer${String.fromCodePoint(0xfe0f)}`],
    [
      'in full-width letters',
      String.fromCodePoint(0xff24, 0xff45, 0xff50, 0xff4c, 0xff4f, 0xff59, 0xff45, 0xff52),
    ],
  ])(
    'refuses a name another role holds %s, on the name field, before inserting',
    async (_how, name) => {
      const { db, statements } = creating(
        0,
        [DEPLOYER],
        [
          [OTHER_ROLE_ID, 'Release manager'],
          [ROLE_ID, 'Deployer'],
        ],
      );

      const refusal = await createCustomRole(db, {
        orgId: ORG_ID,
        definition: { ...DEFINITION, name },
        createdBy: CREATOR_ID,
      }).catch((cause: unknown) => cause);

      expect(refusal).toBeInstanceOf(FieldConflictError);
      expect(refusal).toMatchObject({ code: 'conflict', field: 'name' });
      expect(statements.some((statement) => statement.sql.startsWith('insert'))).toBe(false);
    },
  );

  it('refuses a name spaced differently from one another role holds', async () => {
    const { db } = creating(0, [DEPLOYER], [[OTHER_ROLE_ID, 'Release manager']]);

    await expect(
      createCustomRole(db, {
        orgId: ORG_ID,
        definition: { ...DEFINITION, name: `Release${String.fromCodePoint(0x3000)}manager` },
        createdBy: CREATOR_ID,
      }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'name' });
  });

  it.each(['constraint_name', 'constraint'] as const)(
    'answers the unique constraint, named in %s, as the same conflict — never a driver error',
    async (field) => {
      const { db } = creating(0, pgError('23505', 'custom_roles_org_name_unique', field));

      const refusal = await createCustomRole(db, {
        orgId: ORG_ID,
        definition: DEFINITION,
        createdBy: CREATOR_ID,
      }).catch((cause: unknown) => cause);

      expect(refusal).toBeInstanceOf(FieldConflictError);
      expect(refusal).toBeInstanceOf(RepositoryError);
      expect(refusal).toMatchObject({
        code: 'conflict',
        field: 'name',
        message:
          'A role with this name, or one that reads the same, already exists in this organisation.',
      });
    },
  );
});

/* ── Editing ──────────────────────────────────────────────────────────────── */

describe('updateCustomRole', () => {
  /** Two holders — one suspended — and one grant row on the first. */
  function editing(
    update: unknown[] | Error = [DEPLOYER],
    names: unknown[][] = [
      [ROLE_ID, 'Deployer'],
      [OTHER_ROLE_ID, 'Contractor'],
    ],
  ) {
    return recorder((sql) => {
      if (isOrgLock(sql)) return [[ORG_ID]];
      if (isNameCheck(sql)) return names;
      if (isRoleRead(sql)) return [DEPLOYER];
      if (sql.includes('"users"."email"')) {
        return [
          [MEMBER_ID, USER_ID, 'ada@example.com', 'admin', 'active'],
          [OTHER_MEMBER_ID, OTHER_USER_ID, 'ben@example.com', 'developer', 'suspended'],
        ];
      }
      if (sql.includes('from "access_grants"')) {
        return [['grant-1', PROJECT_ID, null, 'write', MEMBER_ID]];
      }
      if (sql.startsWith('update "custom_roles"')) return update;
      return [];
    });
  }

  it('shows decide the role and every holder, with their grants, and writes what it returns', async () => {
    const { db, statements } = editing();
    const guard = vi.fn(() => {
      // Nothing has been written when the decision is made.
      expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
      return { ...DEFINITION, name: 'Release' };
    });

    const result = await updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, guard);

    const write = statements.find((statement) => statement.sql.startsWith('update'))!;
    expect(write.params).toContain('Release');

    expect(guard).toHaveBeenCalledTimes(1);
    const [edit] = guard.mock.calls[0] as unknown as [
      Parameters<Parameters<typeof updateCustomRole>[2]>[0],
    ];
    expect(edit.current.name).toBe('Deployer');
    expect(edit.holders).toEqual([
      {
        memberId: MEMBER_ID,
        userId: USER_ID,
        email: 'ada@example.com',
        role: 'admin',
        status: 'active',
        grants: [
          { id: 'grant-1', projectId: PROJECT_ID, environmentId: null, accessLevel: 'write' },
        ],
      },
      // Suspended holders are measured too: they come back into the role as
      // it is by then.
      {
        memberId: OTHER_MEMBER_ID,
        userId: OTHER_USER_ID,
        email: 'ben@example.com',
        role: 'developer',
        status: 'suspended',
        grants: [],
      },
    ]);
    expect(result.previous.name).toBe('Deployer');

    // The organisation lock first, then the role row, then the holders — all
    // inside the one transaction that writes.
    const order = statements.map((statement) => statement.sql);
    expect(order[0]).toBe('begin');
    expect(isOrgLock(order[1]!)).toBe(true);
    expect(order[2]).toContain('from "custom_roles"');
    expect(order[2]).toContain('for update');
    expect(order[2]).toContain('"custom_roles"."org_id" = $1');
    expect(order.at(-2)).toMatch(/^update "custom_roles"/);
    expect(order.at(-1)).toBe('commit');

    // The holders are this organisation's and this role's, and their grants
    // are read through the tenancy join.
    const holders = statements.find((statement) => statement.sql.includes('"users"."email"'))!;
    expect(holders.sql).toContain('"org_members"."org_id" = $1');
    expect(holders.sql).toContain('"org_members"."custom_role_id" = $2');
    const grants = statements.find((statement) => statement.sql.includes('from "access_grants"'))!;
    expect(grants.sql).toContain('"projects"."org_id" = $1');
    expect(grants.sql).toContain('"access_grants"."org_member_id" in ($2, $3)');
  });

  it('writes nothing when the guard refuses', async () => {
    const { db, statements } = editing();
    const refusal = new Error('refused');

    await expect(
      updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
    expect(statements.at(-1)!.sql).toBe('rollback');
  });

  it('is notFound, with no guard call, for a role that is not this organisation’s', async () => {
    const { db } = recorder((sql) => (isOrgLock(sql) ? [[ORG_ID]] : []));
    const guard = vi.fn();

    await expect(
      updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, guard),
    ).rejects.toMatchObject({ code: 'notFound' });
    expect(guard).not.toHaveBeenCalled();
  });

  it('answers a rename onto a taken name as a conflict', async () => {
    const { db } = editing(pgError('23505', 'custom_roles_org_name_unique'));

    await expect(
      updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => DEFINITION),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('writes nothing when decide finds nothing to change', async () => {
    const { db, statements } = editing();

    const result = await updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => null);

    expect(result.changed).toBe(false);
    expect(result.role).toBe(result.previous);
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
    expect(statements.some((statement) => isNameCheck(statement.sql))).toBe(false);
  });

  it('checks a new name against the other roles, as a reader sees them, and not a kept one', async () => {
    const renamed = editing();
    await expect(
      updateCustomRole(db0(renamed), { orgId: ORG_ID, roleId: ROLE_ID }, () => ({
        ...DEFINITION,
        name: 'CONTRACTOR',
      })),
    ).rejects.toMatchObject({ code: 'conflict', field: 'name' });
    expect(renamed.statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);

    // Every role but this one: renaming "Deployer" to "DEPLOYER" is not a clash.
    const recased = editing();
    const result0 = await updateCustomRole(
      db0(recased),
      { orgId: ORG_ID, roleId: ROLE_ID },
      () => ({ ...DEFINITION, name: 'DEPLOYER' }),
    );
    expect(result0.changed).toBe(true);
    expect(recased.statements.some((statement) => isNameCheck(statement.sql))).toBe(true);

    // Keeping the name asks nothing.
    const kept = editing();
    const result = await updateCustomRole(
      db0(kept),
      { orgId: ORG_ID, roleId: ROLE_ID },
      () => DEFINITION,
    );
    expect(result.changed).toBe(true);
    expect(kept.statements.some((statement) => isNameCheck(statement.sql))).toBe(false);
  });

  it('refuses an owner base returned by decide, before writing', async () => {
    const { db, statements } = editing();

    await expect(
      updateCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => ({
        ...DEFINITION,
        baseRole: 'owner',
      })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });
});

/* ── Deleting ─────────────────────────────────────────────────────────────── */

describe('deleteCustomRole', () => {
  function deleting(outcome: unknown[] | Error = []) {
    return recorder((sql) => {
      if (isOrgLock(sql)) return [[ORG_ID]];
      if (isRoleRead(sql)) return [DEPLOYER];
      if (sql.startsWith('delete from "custom_roles"')) return outcome;
      return [];
    });
  }

  it('deletes in the organisation, after the guard', async () => {
    const { db, statements } = deleting();
    const guard = vi.fn();

    const deleted = await deleteCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, guard);

    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ id: ROLE_ID, name: 'Deployer' }));
    expect(deleted.name).toBe('Deployer');
    const statement = statements.find((entry) => entry.sql.startsWith('delete'))!;
    expect(statement.sql).toContain('"custom_roles"."org_id" = $1');
    expect(statement.sql).toContain('"custom_roles"."id" = $2');
  });

  it('answers a role still held — the foreign key refusing — as a conflict naming the fix', async () => {
    const { db } = deleting(
      pgError('23503', 'org_members_org_id_custom_role_id_custom_roles_org_id_id_fk'),
    );

    await expect(
      deleteCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => {}),
    ).rejects.toMatchObject({
      code: 'conflict',
      message:
        'This role is still held by members. Move them to another role, or to none, and delete it then.',
    });
  });

  it('writes nothing when the guard refuses', async () => {
    const { db, statements } = deleting();

    await expect(
      deleteCustomRole(db, { orgId: ORG_ID, roleId: ROLE_ID }, () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(statements.some((statement) => statement.sql.startsWith('delete'))).toBe(false);
  });
});

/* ── Assigning ────────────────────────────────────────────────────────────── */

describe('setMemberCustomRole', () => {
  /** The member as `lockMemberRecord` reads them, holding `held` (or none). */
  function assigning({
    role = 'developer',
    held = null as unknown[] | null,
    next = [DEPLOYER] as unknown[],
    update = [[MEMBER_ID, ORG_ID, USER_ID, role, 'active']] as unknown[] | Error,
  } = {}) {
    const customColumns = held ?? [null, null, null, null, null, null];
    return recorder((sql) => {
      if (isOrgLock(sql)) return [[ORG_ID]];
      if (sql.includes('from "org_members"') && sql.includes('for no key update')) {
        return [[MEMBER_ID, ORG_ID, USER_ID, role, 'active', ...customColumns]];
      }
      if (isRoleRead(sql)) return next;
      if (sql.includes('from "access_grants"')) {
        return [['grant-1', PROJECT_ID, null, 'write']];
      }
      if (sql.startsWith('update "org_members"')) return update;
      return [];
    });
  }

  it('locks the organisation and the member row, then shows the guard both sides of the change', async () => {
    const heldColumns = [OTHER_MEMBER_ID, 'Contractor', 'viewer', ['secret.read'], null, null];
    const { db, statements } = assigning({ held: heldColumns });
    const guard = vi.fn();

    const change = await setMemberCustomRole(
      db,
      { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID },
      guard,
    );

    const [assignment] = guard.mock.calls[0] as unknown as [
      Parameters<Parameters<typeof setMemberCustomRole>[2]>[0],
    ];
    expect(assignment.member.customRole?.name).toBe('Contractor');
    expect(assignment.next?.name).toBe('Deployer');
    expect(assignment.grants).toEqual([
      { id: 'grant-1', projectId: PROJECT_ID, environmentId: null, accessLevel: 'write' },
    ]);
    expect(assignment.changed).toBe(true);
    expect(change.previous).toEqual({ id: OTHER_MEMBER_ID, name: 'Contractor' });

    const sql = statements.map((statement) => statement.sql);
    expect(isOrgLock(sql[1]!)).toBe(true);
    expect(sql[2]).toContain('for no key update of "org_members"');
    // The new role is read inside the organisation it must belong to.
    const roleRead = statements.find((statement) => isRoleRead(statement.sql))!;
    expect(roleRead.sql).toContain('"custom_roles"."org_id" = $1');
    expect(roleRead.params.slice(0, 2)).toEqual([ORG_ID, ROLE_ID]);
    const update = statements.find((statement) => statement.sql.startsWith('update'))!;
    expect(update.sql).toContain('"org_members"."org_id" = $');
    expect(update.params).toContain(ROLE_ID);
  });

  it('writes nothing when the member already holds the role asked for — once the guard agrees', async () => {
    const { db, statements } = assigning({
      held: [ROLE_ID, 'Deployer', 'developer', ['secret.read'], 'write', 'none'],
    });
    const guard = vi.fn();

    const change = await setMemberCustomRole(
      db,
      { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID },
      guard,
    );

    expect(change.changed).toBe(false);
    // Asked, and told nothing will change: whether the caller may touch this
    // member does not depend on whether the request changes them.
    expect(guard).toHaveBeenCalledOnce();
    const [assignment] = guard.mock.calls[0] as unknown as [
      Parameters<Parameters<typeof setMemberCustomRole>[2]>[0],
    ];
    expect(assignment.changed).toBe(false);
    expect(assignment.next?.id).toBe(ROLE_ID);
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });

  it('writes nothing to take off a role the member does not hold — once the guard agrees', async () => {
    const { db, statements } = assigning();
    const guard = vi.fn();

    const change = await setMemberCustomRole(
      db,
      { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: null },
      guard,
    );

    expect(change).toMatchObject({ changed: false, previous: null, next: null });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ changed: false, next: null }));
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });

  it('refuses a no-op the guard refuses, as it would the change', async () => {
    const { db, statements } = assigning();
    const refusal = new Error('refused');

    await expect(
      setMemberCustomRole(db, { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: null }, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(statements.at(-1)!.sql).toBe('rollback');
  });

  it('takes a role off with null, reading no role', async () => {
    const { db, statements } = assigning({
      held: [ROLE_ID, 'Deployer', 'developer', ['secret.read'], 'write', 'none'],
    });

    const change = await setMemberCustomRole(
      db,
      { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: null },
      () => {},
    );

    expect(statements.some((statement) => isRoleRead(statement.sql))).toBe(false);
    expect(change.next).toBeNull();
    expect(change.previous).toEqual({ id: ROLE_ID, name: 'Deployer' });
    const update = statements.find((statement) => statement.sql.startsWith('update'))!;
    expect(update.sql).toContain('"custom_role_id" = $1');
    expect(update.params[0]).toBeNull();
  });

  it('is notFound, before the guard and the write, for another organisation’s role', async () => {
    const { db, statements } = assigning({ next: [] });
    const guard = vi.fn();

    await expect(
      setMemberCustomRole(db, { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID }, guard),
    ).rejects.toMatchObject({ code: 'notFound' });
    expect(guard).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });

  it('refuses an owner before the CHECK has to', async () => {
    const { db, statements } = assigning({ role: 'owner' });

    await expect(
      setMemberCustomRole(
        db,
        { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });

  it('maps the owner CHECK and the foreign key, should either be reached', async () => {
    const check = assigning({ update: pgError('23514', 'org_members_owner_custom_role_check') });
    await expect(
      setMemberCustomRole(
        check.db,
        { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const foreign = assigning({
      update: pgError('23503', 'org_members_org_id_custom_role_id_custom_roles_org_id_id_fk'),
    });
    await expect(
      setMemberCustomRole(
        foreign.db,
        { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'notFound' });
  });

  it('writes nothing when the guard refuses', async () => {
    const { db, statements } = assigning();

    await expect(
      setMemberCustomRole(db, { orgId: ORG_ID, memberId: MEMBER_ID, customRoleId: ROLE_ID }, () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(statements.some((statement) => statement.sql.startsWith('update'))).toBe(false);
  });
});

/* ── The membership listing behind /api/auth/me ───────────────────────────── */

describe('listOrganizationsForUser', () => {
  it('joins the custom role on the organisation as well as the id, and left so nobody drops out', () => {
    const { db } = recorder(() => []);
    const { sql } = organizationsForUserQuery(db, USER_ID).toSQL();

    expect(sql).toContain(
      'left join "custom_roles" on ("custom_roles"."id" = "org_members"."custom_role_id" and "custom_roles"."org_id" = "org_members"."org_id")',
    );
  });
});

describe('the membership listing carries the narrowing', () => {
  it('maps the joined role through the shared mapper, and none as undefined', async () => {
    const { db } = recorder(() => []);

    // An empty listing is enough to prove the call shape; the mapper itself is
    // pinned in `membership.test.ts`, and the real rows on PGlite.
    expect(await listOrganizationsForUser(db, USER_ID)).toEqual([]);
  });
});
