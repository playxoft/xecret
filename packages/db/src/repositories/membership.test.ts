import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
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

    expect(member?.customRole).toMatchObject({
      id: ROLE_ID,
      baseRole: 'admin',
      allowedActions: [],
      accessCeiling: { nonProduction: 'none', production: 'none' },
    });
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
