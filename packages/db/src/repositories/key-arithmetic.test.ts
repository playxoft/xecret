import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import {
  addEnvKeyGrants,
  listSealableServiceTokens,
  readInvitationGrants,
  rotateEnvDataKey,
} from './env-keys';
import { loadOrganizationAuthorizationContexts } from './membership';

/**
 * The statements behind the grant-set arithmetic.
 *
 * ── Why these are shape tests and what that buys ──
 * Each function runs against a Drizzle instance whose driver is a recorder: the
 * SQL and its bound parameters are captured, no connection is opened, and every
 * statement returns rows this file supplies. That is enough to assert the
 * properties a code review catches inconsistently and a reviewer cannot check at
 * all from a diff — that a `DELETE` names the ids a tenant-scoped `SELECT`
 * returned rather than a foreign key it was handed, that a bulk read carries no
 * `LIMIT`, that a lock is taken before a decision is made.
 *
 * They cannot prove that PostgreSQL honours the lock, that the transaction rolls
 * back, or that `FOR UPDATE` serialises anything. Those are properties of the
 * database and need an integration suite — the standing caveat `resources.test.ts`
 * records, and it applies here unchanged.
 */

const ORG_ID = '01930000-0000-7000-8000-000000000001';
const PROJECT_ID = '01930000-0000-7000-8000-000000000002';
const ENVIRONMENT_ID = '01930000-0000-7000-8000-000000000003';
const KEY_ID = '01930000-0000-7000-8000-000000000004';
const USER_ID = '01930000-0000-7000-8000-000000000005';
const OTHER_USER_ID = '01930000-0000-7000-8000-000000000006';
const INVITATION_ID = '01930000-0000-7000-8000-000000000007';
const GRANT_ID = '01930000-0000-7000-8000-000000000008';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * A recorder that also answers.
 *
 * `resources.test.ts` uses one that returns nothing, which is right for
 * "does the leading statement carry the tenancy predicate" — every function
 * stops at its first read. The questions here are about statements that only
 * happen *after* several reads succeed, so this one feeds each statement a row
 * chosen by matching on the SQL. Positional arrays, because that is what
 * postgres-js hands Drizzle for a select.
 */
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

/** A sealed grant as the API hands one to the repository. Bytes, never parsed. */
function grantSeed(recipientId: string) {
  return {
    recipientKind: 'member' as const,
    recipientId,
    recipientPublicKey: new Uint8Array(32).fill(7),
    edkSealed: new TextEncoder().encode('xk2.x25519.AAAA'),
    ehkSealed: new TextEncoder().encode('xk2.x25519.BBBB'),
    signature: new TextEncoder().encode('xk2.ed25519.CCCC'),
  };
}

/** Everything a rotation reads on its way to the writes under test. */
function rotationRows(sql: string): unknown[] {
  if (sql.includes('from "organizations"')) return [[ORG_ID]];
  if (sql.includes('from "environments"')) return [[ENVIRONMENT_ID]];
  if (sql.includes('from "env_data_keys"')) return [[KEY_ID, 1]];
  if (sql.startsWith('insert into "env_data_keys"')) {
    return [[KEY_ID, ENVIRONMENT_ID, 2, 'active', USER_ID, new Date()]];
  }
  return [];
}

function statementsMatching(statements: RecordedStatement[], fragment: string) {
  return statements.filter((statement) => statement.sql.includes(fragment));
}

describe('rotateEnvDataKey', () => {
  it('takes the organisation lock before it judges the grant set', async () => {
    // ── The race this closes ──
    // The completeness check used to run before the transaction opened. A member
    // removed in the gap was still in the validated set, so the rotation sealed
    // the brand-new key to the person it was meant to cut off — silently, with a
    // 200 and an `envkey.rotated` record.
    //
    // The organisation row is the lock, not the environment: nothing touches an
    // environment row when somebody is removed from an organisation or has an
    // access grant revoked, so locking it would serialise two rotations and
    // nothing else. `lockOrganization` is what membership and grant writes
    // already take.
    const order: string[] = [];
    const { db, statements } = recorder(rotationRows);

    await rotateEnvDataKey(db, {
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      createdBy: USER_ID,
      version: 2,
      grants: [grantSeed(USER_ID)],
      assertGrantSet: () => {
        order.push('grant set judged');
        return Promise.resolve();
      },
    });

    const lock = statements.findIndex(
      (statement) =>
        statement.sql.includes('from "organizations"') && statement.sql.includes('for update'),
    );
    expect(lock, 'expected the organisation row to be locked').toBeGreaterThanOrEqual(0);

    // The callback ran, and it ran after the lock — which is the only ordering
    // under which its answer cannot have gone stale before the grants are written.
    expect(order).toEqual(['grant set judged']);
    const judged = statements.findIndex((statement) =>
      statement.sql.startsWith('insert into "env_key_grants"'),
    );
    expect(judged).toBeGreaterThan(lock);
  });

  it('settles only the debts it actually paid', async () => {
    // ── The finding ──
    // The delete named the environment and nothing else, so it cleared every
    // queued row — including one recorded *after* the completeness check ran,
    // naming somebody this rotation did not seal to. That person came out holding
    // no grant, listed in no banner, looking at secret names that will not open,
    // with the only record of what they were owed deleted by the act that was
    // supposed to help them.
    const { db, statements } = recorder(rotationRows);

    await rotateEnvDataKey(db, {
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      createdBy: USER_ID,
      version: 2,
      grants: [grantSeed(USER_ID)],
      assertGrantSet: () => Promise.resolve(),
    });

    const deletes = statementsMatching(statements, 'delete from "pending_key_grants"');
    expect(deletes).toHaveLength(1);

    const [settle] = deletes;
    expect(settle!.sql).toContain('target_user_id');
    expect(settle!.params).toContain(USER_ID);
    // And not the person nobody sealed to.
    expect(settle!.params).not.toContain(OTHER_USER_ID);
  });

  it('issues no debt-settling delete when the set grants no member at all', async () => {
    const { db, statements } = recorder(rotationRows);

    await rotateEnvDataKey(db, {
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      createdBy: USER_ID,
      version: 2,
      grants: [{ ...grantSeed(INVITATION_ID), recipientKind: 'invite' as const }],
      assertGrantSet: () => Promise.resolve(),
    });

    expect(statementsMatching(statements, 'delete from "pending_key_grants"')).toHaveLength(0);
  });
});

describe('readInvitationGrants', () => {
  it('reads without consuming, tenant-scoped, and only on the active key', async () => {
    // ── The unusable flow this closes ──
    // This used to read and delete in one transaction, on acceptance. The
    // argument was sound — a fragment in a chat history never expires — and it
    // destroyed the feature: an invitation link's primary population is somebody
    // who has no vault yet, cannot re-seal anything until they set one up, and
    // found the grants gone by the time they had. Consumption moved to the write
    // that stores the re-sealed copy; this is a read and must stay one, or the
    // "enter your code later" path serves keys it has already destroyed.
    const { db, statements } = recorder(() => []);

    await readInvitationGrants(db, { orgId: ORG_ID, invitationId: INVITATION_ID });

    expect(statementsMatching(statements, 'delete')).toHaveLength(0);

    const [query] = statements;
    // Scoped through `projects.org_id`, not by invitation id alone: sealing a
    // grant to a foreign invitation id needs nothing more than knowing it, so
    // without the join one organisation's invitation could serve another's blobs
    // (threat T2).
    expect(query!.sql).toContain('"projects"."org_id" = $');
    expect(query!.params).toContain(ORG_ID);
    // A grant on a rotated-away key opens a key nothing is written under any
    // more, and re-sealing it produces a grant that looks exactly like a working
    // one.
    expect(query!.params).toContain('active');
  });
});

describe('addEnvKeyGrants with claimInvitationId', () => {
  it('destroys the invitation copy only after storing the replacement, in the same transaction', async () => {
    // ── The permanent key loss this closes ──
    // The invite grant is the only copy of an environment key the invitee can
    // reach until their own grant exists. Deleting it before that grant is
    // committed — which is what acceptance did — turns every failure afterwards
    // into an unrecoverable one. Ordering is the fix, and it is only meaningful
    // inside one transaction, so the assertion is on both.
    const { db, statements } = recorder((sql) => {
      if (sql.includes('from "environments"')) return [[ENVIRONMENT_ID]];
      if (sql.includes('from "env_data_keys"')) return [[KEY_ID, 1, 'active']];
      if (sql.startsWith('insert')) return [[GRANT_ID]];
      if (sql.includes('from "env_key_grants"')) return [[GRANT_ID]];
      return [];
    });

    await addEnvKeyGrants(db, {
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: KEY_ID,
      signedByUserId: USER_ID,
      grants: [grantSeed(USER_ID)],
      claimInvitationId: INVITATION_ID,
    });

    const order = statements.map((statement) => statement.sql);
    const insertAt = order.findIndex((sql) => sql.startsWith('insert into "env_key_grants"'));
    const deleteAt = order.findIndex((sql) => sql.startsWith('delete from "env_key_grants"'));

    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(insertAt);

    // Deleted by the ids a select returned, and that select is narrowed to this
    // environment's data keys — so an invitation covering four environments is
    // consumed four times, once per successful re-seal, and a retry after a
    // successful claim finds nothing to do.
    const [consume] = statementsMatching(statements, 'delete from "env_key_grants"');
    expect(consume!.sql).toContain('"env_key_grants"."id" in');
    expect(consume!.params).toEqual([GRANT_ID]);

    const claimQuery = statements.find(
      (statement) =>
        statement.sql.startsWith('select') && statement.sql.includes('from "env_key_grants"'),
    );
    expect(claimQuery!.sql).toContain('"invitation_id" = $');
    expect(claimQuery!.params).toContain(INVITATION_ID);
    expect(claimQuery!.params).toContain(ENVIRONMENT_ID);
  });

  it('consumes nothing when no invitation is being claimed', async () => {
    const { db, statements } = recorder((sql) => {
      if (sql.includes('from "environments"')) return [[ENVIRONMENT_ID]];
      if (sql.includes('from "env_data_keys"')) return [[KEY_ID, 1, 'active']];
      if (sql.startsWith('insert')) return [[GRANT_ID]];
      return [];
    });

    await addEnvKeyGrants(db, {
      orgId: ORG_ID,
      environmentId: ENVIRONMENT_ID,
      envDataKeyId: KEY_ID,
      signedByUserId: USER_ID,
      grants: [grantSeed(USER_ID)],
    });

    expect(statementsMatching(statements, 'delete from "env_key_grants"')).toHaveLength(0);
  });
});

describe('listSealableServiceTokens', () => {
  it('excludes tokens that have expired, matching how one authenticates', async () => {
    // ── The permanent block this closes ──
    // Expiry was not filtered, so a token that stopped working in March stayed
    // *required* in every rotation afterwards: each attempt failed with "Missing a
    // grant for token:…", naming a credential that cannot authenticate and that
    // nobody thinks to revoke because it already stopped working. The
    // environment's key became unrotatable until somebody revoked a dead token.
    //
    // The predicate is the one `findServiceTokenByHash` authenticates with, which
    // is the property that matters: what a rotation must cover and what can
    // actually present itself have to be the same set.
    const { db, statements } = recorder(() => []);

    await listSealableServiceTokens(db, ORG_ID, ENVIRONMENT_ID);

    const [query] = statements;
    expect(query!.sql).toContain('"expires_at" is null');
    expect(query!.sql).toContain('"expires_at" > now()');
    expect(query!.sql).toContain('"revoked_at" is null');
    expect(query!.sql).toContain('"public_key" is not null');
  });
});

describe('loadOrganizationAuthorizationContexts', () => {
  it('reads the roster whole, with no page size to fall off the end of', async () => {
    // ── The silent revocation this closes ──
    // The entitled set used to be computed from `listMembers(…, { pageSize: 200 })`
    // with `hasMore` discarded. At two hundred and one members the answer stopped
    // being *the set* and became *a page of it*, and everybody past the boundary
    // was absent from the required grants — so a rotation omitting them was
    // accepted, revoking them silently through the check that exists to prevent
    // silent revocation.
    //
    // A `LIMIT` appearing in this statement would reintroduce it, which is why the
    // assertion is on its absence rather than on a number.
    const { db, statements } = recorder((sql) =>
      sql.includes('from "org_members"')
        ? [['member-1', ORG_ID, USER_ID, 'developer', 'active']]
        : [],
    );

    await loadOrganizationAuthorizationContexts(db, { orgId: ORG_ID, projectId: PROJECT_ID });

    const [roster, grants] = statements;
    expect(roster!.sql).not.toContain('limit');
    expect(roster!.sql).toContain('"org_id" = $');
    // Active members only: a suspended one resolves to `none` everywhere anyway,
    // so absence here means what `loadAuthorizationContext` returning null means.
    expect(roster!.params).toContain('active');

    // Two statements, whatever the size of the roster — the whole point of the
    // batched read. The grants are narrowed to the project, because
    // `resolveAccessLevel` consults no other.
    expect(statements).toHaveLength(2);
    expect(grants!.sql).toContain('from "access_grants"');
    expect(grants!.sql).not.toContain('limit');
    expect(grants!.params).toContain(PROJECT_ID);
  });

  it('spends no second statement on an organisation with no active members', async () => {
    const { db, statements } = recorder(() => []);

    await loadOrganizationAuthorizationContexts(db, { orgId: ORG_ID });

    expect(statements).toHaveLength(1);
  });
});
