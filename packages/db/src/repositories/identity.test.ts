import { describe, expect, it } from 'vitest';
import { hashToken } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@xecret/core/validation';
import { createDatabase } from '../client';
import {
  accountLockQuery,
  organizationsForUserQuery,
  organizationsHeldByQuery,
  orgSlugCandidate,
  personalOrgSlugSeed,
} from './organizations';
import {
  memberGrantsQuery,
  membersPageQuery,
  membershipQuery,
  toAuthorizationContext,
  wouldStrandOrganization,
} from './membership';
import { sessionLookupQuery, userSessionsQuery } from './sessions';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize } from './shared';
import type { MemberGrant, MemberRecord, OwnershipChange } from './membership';

/**
 * What these tests prove — and what they do not.
 *
 * There is no PostgreSQL instance behind this file. The query tests build a
 * statement and inspect the SQL Drizzle generates from it, so what they verify is
 * *shape*: that the tenancy predicate is present, that revoked sessions and
 * soft-deleted users are filtered, that `token_hash` appears in no select list.
 * The rest is pure logic — slug suffixing, page clamping, the last-owner
 * decision, the row-to-context mapping — tested directly.
 *
 * None of this proves the queries return the right rows, that PostgreSQL chooses
 * the indexes they were written for, that the transactions isolate as intended,
 * or that the last-owner guard holds against two concurrent writers. Those need a
 * real database, and integration coverage is still required before production.
 *
 * A test that claims more than it checks is worse than no test, so this file
 * claims exactly this much: a refactor that silently drops one of these controls
 * fails here instead of passing review.
 */

/**
 * A client that is never queried. postgres.js connects lazily, so building a
 * statement and calling `.toSQL()` opens no socket and reaches no database.
 */
const db = createDatabase({ connectionString: 'postgres://xecret@localhost:5432/xecret' });

const NOW = new Date('2026-08-11T12:00:00.000Z');
const ORG_ID = uuidv7();
const USER_ID = uuidv7();
const MEMBER_ID = uuidv7();
const PROJECT_ID = uuidv7();

describe('resolving a request from its session cookie', () => {
  const lookup = async () =>
    sessionLookupQuery(db, await hashToken('xes_live_example'), NOW).toSQL();

  it('matches on the hash of the token, never on the token', async () => {
    const { sql, params } = await lookup();

    expect(sql).toContain('"sessions"."token_hash" = $1');
    expect(params[0]).toEqual(Buffer.from(await hashToken('xes_live_example')));
  });

  it('excludes revoked sessions in SQL, which is what makes the partial index usable', async () => {
    // sessions_lookup_idx is partial on `revoked_at IS NULL`; without the
    // predicate PostgreSQL cannot choose it, so this is correctness and the hot
    // path at the same time.
    expect((await lookup()).sql).toContain('"sessions"."revoked_at" is null');
  });

  it('excludes soft-deleted users in the join, so a deleted account loses its sessions at once', async () => {
    const { sql } = await lookup();

    expect(sql).toContain('inner join "users"');
    expect(sql).toContain('"users"."deleted_at" is null');
  });

  it('prunes absolutely expired rows against the clock the caller passed', async () => {
    const { sql, params } = await lookup();

    expect(sql).toContain('"sessions"."expires_at" > $2');
    expect(params).toContain(NOW.toISOString());
  });

  it('resolves the actor in one query rather than a session read plus a user read', async () => {
    const { sql } = await lookup();

    expect(sql.match(/ from /g)).toHaveLength(1);
    expect(sql).toContain('limit');
  });
});

describe('the active-devices list', () => {
  it('never selects token_hash — there is no reason for it to leave the database', () => {
    expect(userSessionsQuery(db, USER_ID).toSQL().sql).not.toContain('token_hash');
  });

  it('is scoped to one user and bounded', () => {
    const { sql, params } = userSessionsQuery(db, USER_ID).toSQL();

    expect(sql).toContain('"sessions"."user_id" = $1');
    expect(params).toContain(USER_ID);
    expect(params).toContain(MAX_PAGE_SIZE);
  });
});

describe('every org-scoped read filters on the organisation (threat T2)', () => {
  const orgScoped: [string, { toSQL: () => { sql: string; params: unknown[] } }][] = [
    ['membership', membershipQuery(db, ORG_ID, USER_ID)],
    ['grants', memberGrantsQuery(db, { orgId: ORG_ID, memberId: MEMBER_ID })],
    ['member page', membersPageQuery(db, ORG_ID, 1, 25)],
  ];

  it.each(orgScoped)('%s binds the organisation id', (_name, query) => {
    const { sql, params } = query.toSQL();

    expect(sql).toContain('org_id');
    expect(params).toContain(ORG_ID);
  });

  it('reaches a member only through their own organisation', () => {
    const { sql } = membershipQuery(db, ORG_ID, USER_ID).toSQL();

    expect(sql).toContain('"org_members"."org_id" = $1');
    expect(sql).toContain('"org_members"."user_id" = $2');
    // A soft-deleted organisation stops resolving for every member at once.
    expect(sql).toContain('"organizations"."deleted_at" is null');
  });

  it('reads grants through the projects of that organisation only', () => {
    // access_grants has no foreign key to organizations, so this join is the
    // only thing standing between a cross-tenant grant row and a permission
    // decision made from it.
    const { sql } = memberGrantsQuery(db, { orgId: ORG_ID, memberId: MEMBER_ID }).toSQL();

    expect(sql).toContain('inner join "projects"');
    expect(sql).toContain('"projects"."org_id" = $1');
    expect(sql).toContain('"projects"."deleted_at" is null');
    expect(sql).toContain('"access_grants"."org_member_id" = $2');
  });

  it('narrows grants to one project when the decision is about that project', () => {
    const { sql, params } = memberGrantsQuery(db, {
      orgId: ORG_ID,
      memberId: MEMBER_ID,
      projectId: PROJECT_ID,
    }).toSQL();

    expect(sql).toContain('"access_grants"."project_id" = $3');
    expect(params).toContain(PROJECT_ID);
  });

  it('lists only the organisations where the membership is active', () => {
    const { sql, params } = organizationsForUserQuery(db, USER_ID).toSQL();

    expect(sql).toContain('"org_members"."user_id" = $1');
    expect(sql).toContain('"org_members"."status" = $2');
    expect(params).toContain('active');
    expect(sql).toContain('"organizations"."deleted_at" is null');
  });

  it('breaks a tie on organisation name, which is not unique', () => {
    // The dashboard falls back to the first of these rows for routes that name
    // no organisation, so an unspecified order between two organisations
    // sharing a name is a sidebar that re-points itself between reloads.
    const { sql } = organizationsForUserQuery(db, USER_ID).toSQL();

    expect(sql).toContain('order by "organizations"."name" asc, "organizations"."id" asc');
  });

  it('excludes soft-deleted users from the member list', () => {
    expect(membersPageQuery(db, ORG_ID, 1, 25).toSQL().sql).toContain(
      '"users"."deleted_at" is null',
    );
  });
});

/**
 * The query behind the per-account organisation cap.
 *
 * `provisionOrganization` refuses on what this returns, so each clause is a
 * security property rather than a detail: attribute it to the wrong column and
 * one account's colleagues can exhaust their allowance; drop the membership join
 * and an organisation somebody was removed from stands against their ceiling for
 * ever, with no request they can make to release it; drop the `deleted_at`
 * filter and closing an organisation stops giving a place back, turning a cap
 * into a one-way ratchet.
 */
describe('counting the organisations an account holds', () => {
  it('attributes them by creator, not by who happens to own one now', () => {
    const { sql, params } = organizationsHeldByQuery(db, USER_ID, 10).toSQL();

    expect(sql).toContain('"organizations"."created_by" = $1');
    expect(params).toContain(USER_ID);
  });

  /**
   * The half that makes the quota recoverable.
   *
   * Releasing a place means deleting the organisation, and `DELETE
   * /api/orgs/{slug}` resolves through `resolveOrg`, which answers 404 without a
   * membership. Counting `created_by` alone therefore let a co-owner remove the
   * creator from ten organisations and permanently stop that account creating an
   * eleventh. It is also what keeps the first-login bootstrap under the ceiling
   * by construction: no memberships, nothing counted.
   */
  it('counts only the ones the account is still an active member of', () => {
    const { sql, params } = organizationsHeldByQuery(db, USER_ID, 10).toSQL();

    expect(sql).toContain('inner join "org_members"');
    expect(sql).toContain('"org_members"."org_id" = "organizations"."id"');
    expect(sql).toContain('"org_members"."user_id" = $2');
    expect(sql).toContain('"org_members"."status" = $3');
    expect(params).toEqual([USER_ID, USER_ID, 'active', 10]);
  });

  it('ignores soft-deleted organisations, so deleting one frees a place', () => {
    expect(organizationsHeldByQuery(db, USER_ID, 10).toSQL().sql).toContain(
      '"organizations"."deleted_at" is null',
    );
  });

  // The caller asks "is this account at its limit", which `LIMIT n` answers
  // exactly. Reading further would scan every organisation an account has ever
  // created to compute a number nobody acts on.
  it('reads no more rows than the limit it was asked about', () => {
    const { sql, params } = organizationsHeldByQuery(db, USER_ID, 10).toSQL();

    expect(sql).toContain('limit');
    expect(params).toContain(10);
  });

  // The route files the refusal against the first row, and `audit_logs.org_id`
  // is NOT NULL. Ids are UUIDv7, so descending id is descending creation time.
  // `organizations_creator_idx` supplies this order, read backwards.
  it('returns the most recently created organisation first', () => {
    expect(organizationsHeldByQuery(db, USER_ID, 10).toSQL().sql).toContain(
      'order by "organizations"."id" desc',
    );
  });
});

/**
 * The lock that makes the cap a ceiling rather than a suggestion.
 *
 * The count and the insert are separate statements with an entire transaction
 * between them, and no constraint downstream can express "at most ten" — so
 * without serialisation every concurrent request that read nine passed. The
 * rate limiter is not a backstop: Cloudflare's counters are per-colo, and
 * `consume` fails open when the binding is absent, which is the documented state
 * of a local or self-hosted deployment.
 */
describe('serialising one account against itself', () => {
  it('locks the account row, which is the only row two creations share', () => {
    const { sql, params } = accountLockQuery(db, USER_ID).toSQL();

    expect(sql).toContain('from "users"');
    expect(sql).toContain('"users"."id" = $1');
    expect(sql).toContain('for update');
    expect(params).toContain(USER_ID);
  });

  it('takes no lock on an account that has been deleted', () => {
    expect(accountLockQuery(db, USER_ID).toSQL().sql).toContain('"users"."deleted_at" is null');
  });
});

describe('pagination', () => {
  it('clamps a missing or nonsensical page size to the default', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('clamps at both boundaries', () => {
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-10)).toBe(1);
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(10.9)).toBe(10);
  });

  it('reads one row beyond the page so "has more" costs no second count', () => {
    const { params } = membersPageQuery(db, ORG_ID, 3, 25).toSQL();

    expect(params).toContain(26);
    expect(params).toContain(50);
  });
});

describe('personal organisation slugs', () => {
  it('takes the local part of the email address', () => {
    expect(personalOrgSlugSeed('nitheesh@playxoft.com')).toBe('nitheesh');
  });

  it("drops an address tag, which routes mail but is not part of anyone's name", () => {
    expect(personalOrgSlugSeed('nitheesh+xecret@playxoft.com')).toBe('nitheesh');
  });

  it('leaves a string with no address structure alone, for slugify to deal with', () => {
    expect(personalOrgSlugSeed('Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('suffixes collisions with a readable counter', () => {
    expect(orgSlugCandidate('acme', 0)).toBe('acme');
    expect(orgSlugCandidate('acme', 1)).toBe('acme-2');
    expect(orgSlugCandidate('acme', 7)).toBe('acme-8');
  });

  it('truncates the base, not the suffix, so a long name stays within the limit', () => {
    const base = 'a'.repeat(SLUG_MAX_LENGTH);
    const candidate = orgSlugCandidate(base, 11);

    expect(candidate.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(candidate.endsWith('-12')).toBe(true);
    expect(candidate).toMatch(SLUG_PATTERN);
  });

  it('never produces a double hyphen when truncation lands on one', () => {
    const base = `${'a'.repeat(SLUG_MAX_LENGTH - 3)}-bb`;
    const candidate = orgSlugCandidate(base, 1);

    expect(candidate).not.toContain('--');
    expect(candidate).toMatch(SLUG_PATTERN);
  });
});

describe('the last-owner guard', () => {
  /**
   * Demotion, removal and suspension all reduce to the same question — is this
   * member still an active owner afterwards? — so the predicate is tested
   * exhaustively over its own inputs rather than once per operation.
   */
  const cases: (OwnershipChange & { strands: boolean; title: string })[] = [
    {
      title: 'rejects the change when the last active owner would stop being one',
      activeOwnerCount: 1,
      memberIsActiveOwner: true,
      remainsActiveOwner: false,
      strands: true,
    },
    {
      title: 'allows it when another active owner remains',
      activeOwnerCount: 2,
      memberIsActiveOwner: true,
      remainsActiveOwner: false,
      strands: false,
    },
    {
      title: 'allows the only owner to stay an owner',
      activeOwnerCount: 1,
      memberIsActiveOwner: true,
      remainsActiveOwner: true,
      strands: false,
    },
    {
      title: 'never blocks a change to someone who is not an active owner',
      activeOwnerCount: 1,
      memberIsActiveOwner: false,
      remainsActiveOwner: false,
      strands: false,
    },
    {
      title: 'does not block repairs to an organisation that already has no active owner',
      activeOwnerCount: 0,
      memberIsActiveOwner: false,
      remainsActiveOwner: false,
      strands: false,
    },
  ];

  it.each(cases)('$title', ({ strands, title: _title, ...change }) => {
    expect(wouldStrandOrganization(change)).toBe(strands);
  });
});

describe('the authorization context handed to can()', () => {
  const member: MemberRecord = {
    id: MEMBER_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    role: 'developer',
    status: 'active',
  };

  const grants: MemberGrant[] = [
    { id: uuidv7(), projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
    { id: uuidv7(), projectId: PROJECT_ID, environmentId: uuidv7(), accessLevel: 'write' },
  ];

  it('carries the member id, because grants are keyed by it rather than by user', () => {
    expect(toAuthorizationContext(member, grants).memberId).toBe(MEMBER_ID);
  });

  it('carries the role and status, so a suspended member is visible to the policy', () => {
    const context = toAuthorizationContext({ ...member, status: 'suspended' }, []);

    expect(context.role).toBe('developer');
    expect(context.status).toBe('suspended');
  });

  it('keeps a project-wide grant distinguishable from an environment-specific one', () => {
    const [projectWide, environmentSpecific] = toAuthorizationContext(member, grants).grants;

    expect(projectWide?.environmentId).toBeNull();
    expect(environmentSpecific?.environmentId).not.toBeNull();
  });

  it('passes grants through untouched, so precedence is decided in one place', () => {
    expect(toAuthorizationContext(member, grants).grants).toEqual(grants);
  });
});
