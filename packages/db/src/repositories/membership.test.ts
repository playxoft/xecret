import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { can, resolveAccessLevel } from '@xecret/core/authz';
import type { Action, Membership } from '@xecret/core/authz';
import * as schema from '../schema';
import type { Database } from '../client';
import {
  addMember,
  findMemberWithUser,
  findMembership,
  listMembers,
  loadAuthorizationContext,
  loadOrganizationAuthorizationContexts,
  reinstateMember,
  removeMember,
  suspendMember,
  toAuthorizationContext,
  updateMemberRole,
} from './membership';

/**
 * Where a member's custom role is read, and where it must not be.
 *
 * ── Why these exist ──
 * The custom-role columns were first added to the one column set every member
 * statement shared. That broke three things no reviewer could see in a diff and
 * no shape test was looking for: every membership write, because a `RETURNING`
 * list named `custom_roles`; every read that did not join the table, because the
 * columns had no `FROM` entry; and the org-wide loader, which handed the raw row
 * on and so never carried the role at all — on the path that decides who an
 * environment key is sealed to.
 *
 * The same recorder as `key-arithmetic.test.ts`: statements are captured, no
 * connection is opened, and each returns rows this file supplies, positionally,
 * in the order the column sets declare them. What that cannot prove — that
 * PostgreSQL accepts the SQL at all — is the standing caveat `resources.test.ts`
 * records, and it applies here unchanged.
 */

const ORG_ID = '01930000-0000-7000-8000-000000000001';
const USER_ID = '01930000-0000-7000-8000-000000000002';
const MEMBER_ID = '01930000-0000-7000-8000-000000000003';
const ROLE_ID = '01930000-0000-7000-8000-000000000004';
const OTHER_USER_ID = '01930000-0000-7000-8000-000000000005';
const OTHER_MEMBER_ID = '01930000-0000-7000-8000-000000000006';
const PROJECT_ID = '01930000-0000-7000-8000-000000000007';
const ENVIRONMENT_ID = '01930000-0000-7000-8000-000000000008';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

function recorder(rowsFor: (sql: string) => unknown[]): {
  db: Database;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });
      const rows = rowsFor(sql);
      const result = Promise.resolve(rows) as Promise<unknown[]> & {
        values: () => Promise<unknown[]>;
      };
      result.values = () => Promise.resolve(rows);
      return result;
    },
    begin: <T>(run: (client: unknown) => Promise<T>) => run(client),
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

/** `org_members` alone: what `RETURNING` and the last-owner lookup read. */
const MEMBER_ROW = [MEMBER_ID, ORG_ID, USER_ID, 'admin', 'active'];

/**
 * The joined custom-role columns for an admin who may manage staging and never
 * reach production — the case the feature exists for, and the one a dropped
 * ceiling turns into a key sealed to the wrong person.
 */
const STAGING_OPERATOR = [
  ROLE_ID,
  'Staging operator',
  'admin',
  ['secret.read', 'secret.update'],
  'admin',
  'none',
];

/** A member who holds no custom role: the LEFT join's all-null half. */
const NO_CUSTOM_ROLE = [null, null, null, null, null, null];

/** The person behind a roster row. */
const LIST_TAIL = [true, '2026-08-11T12:00:00.000Z', USER_ID, 'ada@example.com', 'Ada', null];

describe('the org-wide authorization loader', () => {
  it('carries the custom role, ceiling included, onto the context', async () => {
    const { db } = recorder((sql) =>
      sql.includes('from "org_members"')
        ? [
            [...MEMBER_ROW, ...STAGING_OPERATOR],
            [OTHER_MEMBER_ID, ORG_ID, OTHER_USER_ID, 'admin', 'active', ...NO_CUSTOM_ROLE],
          ]
        : [],
    );

    const [narrowed, plain] = await loadOrganizationAuthorizationContexts(db, { orgId: ORG_ID });

    // The environment-key grant set is decided from this answer. Without the
    // ceiling here, "admin" resolves to `admin` on production and the key is
    // sealed to exactly the person the role was defined to keep out.
    expect(narrowed!.customRole).toEqual({
      id: ROLE_ID,
      name: 'Staging operator',
      baseRole: 'admin',
      allowedActions: ['secret.read', 'secret.update'],
      accessCeiling: { nonProduction: 'admin', production: 'none' },
    });

    // And a member without one is handed on exactly as before the column existed.
    expect(plain!.memberId).toBe(OTHER_MEMBER_ID);
    expect(plain).not.toHaveProperty('customRole');
  });
});

describe('every read that answers for a member', () => {
  const joined = (sql: string) => {
    if (!sql.includes('from "org_members"')) return [];
    return sql.includes('"users"."email"')
      ? [[...MEMBER_ROW, ...STAGING_OPERATOR, ...LIST_TAIL]]
      : [[...MEMBER_ROW, ...STAGING_OPERATOR]];
  };

  it('resolves the custom role through the one mapper, and leaks none of its columns', async () => {
    const { db } = recorder(joined);

    const records = [
      await findMembership(db, ORG_ID, USER_ID),
      await loadAuthorizationContext(db, { orgId: ORG_ID, userId: USER_ID }),
      await findMemberWithUser(db, ORG_ID, MEMBER_ID),
      (await listMembers(db, ORG_ID)).members[0],
    ];

    for (const record of records) {
      expect(record?.customRole?.accessCeiling).toEqual({
        nonProduction: 'admin',
        production: 'none',
      });
      // The loose join columns stop at the mapper. A roster payload built by
      // spreading one of these must not find `customRoleName` and friends in it.
      const keys = Object.keys(record ?? {});
      expect(keys.filter((key) => key.startsWith('customRole'))).toEqual(['customRole']);
    }
  });

  it('shuts a member out when their role reference does not resolve inside the organisation', async () => {
    // The join matches on the organisation as well as the id, so a row naming
    // another tenant's role joins nothing. Reading that as "no custom role"
    // would restore the full built-in role — a widening nobody chose.
    const { db } = recorder((sql) =>
      sql.includes('from "org_members"')
        ? [[...MEMBER_ROW, ROLE_ID, null, null, null, null, null]]
        : [],
    );

    const member = await findMembership(db, ORG_ID, USER_ID);

    // Based on `viewer` whatever the stored role — `admin` here — so every
    // reader of `effectiveRole` sees the minimum, not only the capability table.
    expect(member?.customRole).toMatchObject({
      id: ROLE_ID,
      baseRole: 'viewer',
      allowedActions: [],
      accessCeiling: { nonProduction: 'none', production: 'none' },
    });
    expect(member?.role).toBe('admin');

    // The shape is only half the claim; the other half is what the engine
    // does with it. An explicit project-wide `admin` grant is included on
    // purpose: the ceiling has to hold against a grant, not only a default.
    const membership: Membership = {
      role: member!.role,
      memberStatus: member!.status,
      customRole: member!.customRole,
      grants: [{ projectId: PROJECT_ID, environmentId: null, accessLevel: 'admin' }],
    };
    const actor = { kind: 'user', userId: USER_ID, orgId: ORG_ID } as const;
    const environment = {
      kind: 'environment',
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
    } as const;

    for (const isProduction of [false, true]) {
      for (const action of ['secret.read', 'secret.update'] satisfies Action[]) {
        expect(
          can(actor, action, environment, { membership, isProduction }).allowed,
          `${action}, production: ${isProduction}`,
        ).toBe(false);
      }
      expect(resolveAccessLevel({ ...membership, isProduction }, PROJECT_ID, ENVIRONMENT_ID)).toBe(
        'none',
      );
      expect(resolveAccessLevel({ ...membership, isProduction }, PROJECT_ID, null)).toBe('none');
    }
    expect(
      can(
        actor,
        'member.invite',
        { kind: 'org', orgId: ORG_ID },
        { membership, isProduction: false },
      ).allowed,
    ).toBe(false);
  });

  it('fails closed on a half-set ceiling, reading the missing half as none', async () => {
    // `custom_roles_ceiling_check` forbids the row. Should one arrive anyway,
    // dropping the whole ceiling would hand the member their unnarrowed level in
    // both kinds of environment; capping the missing half at `none` does not.
    const [, name, base, actions] = STAGING_OPERATOR;
    const halfSet = [
      [ROLE_ID, name, base, actions, 'admin', null],
      [ROLE_ID, name, base, actions, null, 'read'],
    ];

    const ceilings = [];
    for (const columns of halfSet) {
      const { db } = recorder((sql) =>
        sql.includes('from "org_members"') ? [[...MEMBER_ROW, ...columns]] : [],
      );
      ceilings.push((await findMembership(db, ORG_ID, USER_ID))?.customRole?.accessCeiling);
    }

    expect(ceilings).toEqual([
      { nonProduction: 'admin', production: 'none' },
      { nonProduction: 'none', production: 'read' },
    ]);
  });
});

/** Runs every member read and write once, returning what was sent to the database. */
async function everyMemberStatement(): Promise<RecordedStatement[]> {
  const { db, statements } = recorder((sql) => {
    // `lockOrganization`, which every member write takes first.
    if (sql.includes('from "organizations"')) return [[ORG_ID]];
    if (sql.startsWith('insert into "org_members"') || sql.startsWith('update "org_members"')) {
      return [MEMBER_ROW];
    }
    // The last-owner lookup and the joined reads alike: rows need not be
    // realistic here, only present, so each function reaches its write.
    if (sql.includes('from "org_members"')) {
      return sql.includes('"custom_roles"')
        ? [[...MEMBER_ROW, ...NO_CUSTOM_ROLE, ...LIST_TAIL]]
        : [MEMBER_ROW];
    }
    return [];
  });

  const ref = { orgId: ORG_ID, memberId: MEMBER_ID };
  await findMembership(db, ORG_ID, USER_ID);
  await loadAuthorizationContext(db, { orgId: ORG_ID, userId: USER_ID });
  await loadOrganizationAuthorizationContexts(db, { orgId: ORG_ID });
  await findMemberWithUser(db, ORG_ID, MEMBER_ID);
  await listMembers(db, ORG_ID);
  await addMember(db, { orgId: ORG_ID, userId: USER_ID, role: 'developer', invitedBy: null });
  await updateMemberRole(db, { ...ref, role: 'developer' });
  await suspendMember(db, ref);
  await reinstateMember(db, ref);
  await removeMember(db, ref);

  return statements;
}

describe('member writes', () => {
  it('return only what the written table has, so RETURNING never names custom_roles', async () => {
    // A `RETURNING` list can name only the table being written. One
    // `custom_roles` column in it and PostgreSQL rejects the statement — every
    // insert, role change, suspension and reinstatement, all at once.
    const writes = (await everyMemberStatement()).filter(
      ({ sql }) =>
        sql.startsWith('insert into "org_members"') || sql.startsWith('update "org_members"'),
    );

    expect(writes).toHaveLength(4);
    for (const { sql } of writes) {
      expect(sql).toContain(' returning ');
      expect(sql).not.toContain('custom_roles');
    }
  });

  /** Runs one role change and returns the UPDATE it sent. */
  async function roleUpdate(role: 'owner' | 'admin' | 'developer' | 'viewer') {
    const { db, statements } = recorder((sql) => {
      if (sql.includes('from "organizations"')) return [[ORG_ID]];
      if (sql.startsWith('update "org_members"'))
        return [[MEMBER_ID, ORG_ID, USER_ID, role, 'active']];
      if (sql.includes('from "org_members"')) return [MEMBER_ROW];
      return [];
    });

    await updateMemberRole(db, { orgId: ORG_ID, memberId: MEMBER_ID, role });

    const update = statements.find(({ sql }) => sql.startsWith('update "org_members"'));
    expect(update).toBeDefined();
    return update!;
  }

  it('clears the custom role in the same UPDATE that makes somebody an owner', async () => {
    // `org_members_owner_custom_role_check` rejects an owner holding a custom
    // role, so a promotion that left the reference in place would be a CHECK
    // violation — a 500 — for every narrowed member ever promoted.
    const { sql, params } = await roleUpdate('owner');

    const setClause = /^update "org_members" set (.+?) where /.exec(sql)?.[1] ?? '';
    const role = /"role" = \$(\d+)/.exec(setClause);
    const customRole = /"custom_role_id" = \$(\d+)/.exec(setClause);

    expect(role, `no role assignment in: ${sql}`).not.toBeNull();
    expect(customRole, `custom_role_id is not cleared in: ${sql}`).not.toBeNull();
    expect(params[Number(role![1]) - 1]).toBe('owner');
    expect(params[Number(customRole![1]) - 1]).toBeNull();
  });

  it.each(['admin', 'developer', 'viewer'] as const)(
    'leaves the custom role alone on a change to %s',
    async (role) => {
      // A narrowing is only ever dropped by the promotion that subsumes it;
      // every other role change keeps it exactly as it was.
      const { sql } = await roleUpdate(role);
      expect(sql).not.toContain('custom_role_id');
    },
  );

  it('return a record an authorization context cannot be built from', async () => {
    // `RETURNING` cannot name `custom_roles`, so a write's record has no
    // `customRole` because none was loaded — and `toAuthorizationContext` would
    // read that absence as "holds none". Nothing stops it at runtime, which is
    // why the type does; `tsc` fails this file if the directive stops being
    // needed.
    const { db } = recorder((sql) => {
      if (sql.includes('from "organizations"')) return [[ORG_ID]];
      return sql.includes('"org_members"') ? [MEMBER_ROW] : [];
    });

    const written = await suspendMember(db, { orgId: ORG_ID, memberId: MEMBER_ID });

    // @ts-expect-error — a WrittenMemberRecord is not a joined read.
    const context = toAuthorizationContext(written, []);
    expect(context).not.toHaveProperty('customRole');
  });
});

describe('the join onto custom_roles', () => {
  it('is present wherever a custom_roles column is selected, and matches on the organisation', async () => {
    // A column whose table is not in `FROM` fails at PostgreSQL, not at the
    // type checker — which is how the last-owner lookup came to break. And a
    // join on the id alone lets a row pointing at another tenant's role decide
    // this organisation's access.
    const statements = await everyMemberStatement();
    const touching = statements.filter(({ sql }) => sql.includes('custom_roles'));

    // findMembership, loadAuthorizationContext, the org-wide loader,
    // findMemberWithUser and listMembers: five reads, and nothing else.
    expect(touching).toHaveLength(5);
    for (const { sql } of touching) {
      expect(sql.startsWith('select')).toBe(true);

      const join = /left join "custom_roles" on (.+?)(?: left join | inner join | where |$)/.exec(
        sql,
      );
      expect(join, `no join onto custom_roles in: ${sql}`).not.toBeNull();
      expect(join![1]).toContain('"custom_roles"."id" = "org_members"."custom_role_id"');
      expect(join![1]).toContain('"custom_roles"."org_id" = "org_members"."org_id"');
    }
  });
});
