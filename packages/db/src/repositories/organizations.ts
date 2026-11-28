import { and, asc, count, desc, eq, exists, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CustomRole, OrgRole } from '@xecret/core/authz';
import {
  AWAITING_ORGANIZATIONS_PER_ACCOUNT,
  FREE_ORGANIZATIONS_PER_ACCOUNT,
} from '@xecret/core/entitlements';
import type { EnvelopeService } from '@xecret/core/crypto';
import { isUuid, uuidv7 } from '@xecret/core/ids';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  truncateName,
} from '@xecret/core/validation';
import { sessions, users } from '../schema/identity';
import { orgKeys } from '../schema/keys';
import { cliTokens } from '../schema/tokens';
import { environments, projects } from '../schema/resources';
import { orgSubscriptions } from '../schema/billing';
import { customRoles } from '../schema/roles';
import { orgMembers, organizations, workosHome } from '../schema/tenancy';
import { countAwaitingOrganizations, countOpenFreeOrganizations } from './free-allowance';
import { addMember, CUSTOM_ROLE_COLUMNS, customRoleJoin, toCustomRole } from './membership';
import type { WrittenMemberRecord } from './membership';
import { QuotaExceededError, RepositoryError } from './shared';
import type { Executor } from './shared';
import { createFreeSubscription, entitlementColumns } from './subscriptions';
import type { SubscriptionEntitlementRow } from './subscriptions';
import { isUniqueViolation } from './users';
import type { User } from './users';

/**
 * Organisations, and the bootstrap that turns a verified identity into a usable
 * account. See docs/architecture/database-schema.md §2 and §4.
 */

export type Organization = typeof organizations.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Environment = typeof environments.$inferSelect;

/** An organisation together with the caller's role in it. */
export interface OrganizationMembership {
  organization: Organization;
  role: OrgRole;
  /**
   * The custom role narrowing `role`, or `undefined` when they hold none.
   *
   * Carried so a client can be told what the member may actually do rather
   * than what their stored role alone would allow — `GET /api/auth/me` turns
   * the pair into an `authoritySummary`. Read through the same join and the
   * same mapper as every other membership read (`toCustomRole`), so an
   * unresolved reference arrives as the deny-everything role, not as none.
   */
  customRole: CustomRole | undefined;
}

const SLUG_UNIQUE_CONSTRAINT = 'organizations_slug_unique';

const WORKOS_ORG_ID_UNIQUE_CONSTRAINT = 'organizations_workos_org_id_unique';

const FALLBACK_ORGANIZATION_NAME = 'My Organisation';

/**
 * An organisation and its entitlement columns, in one row.
 *
 * ── Why a join and not a second lookup ──
 * Entitlements are the third authorization gate, so they are needed on every
 * tenant-scoped request. `resolveOrg` already reads the organisation, by its
 * id or by a legacy slug; adding a second query to answer a billing question
 * would put a round trip on the path of every secret fetch, for a value that
 * changes about once a month.
 *
 * A `LEFT JOIN` rather than an inner one: migration 0016 backfilled every
 * organisation and provisioning inserts alongside, so the row is always there —
 * but an inner join would turn a missing subscription into a *missing
 * organisation*, which is a 404 for a tenant that plainly exists. The null case
 * resolves to Free, which is the same answer the migration would have written.
 */
export interface OrganizationWithEntitlements {
  organization: Organization;
  entitlements: SubscriptionEntitlementRow | null;
}

/**
 * @internal Exported so `subscriptions.test.ts` can assert the join exists and
 * that the projection carries no provider identifier, without a database.
 */
export function organizationBySlugWithEntitlementsQuery(exec: Executor, slug: string) {
  return organizationWithEntitlementsQuery(exec, eq(organizations.slug, slug));
}

/**
 * The same row, found by the organisation's id: what every address the
 * dashboard builds names it by.
 *
 * @internal Exported beside the slug query so a test can assert that both
 * carry the same join and the same `deleted_at` filter.
 */
export function organizationByIdWithEntitlementsQuery(exec: Executor, orgId: string) {
  return organizationWithEntitlementsQuery(exec, eq(organizations.id, orgId));
}

/**
 * One query, two keys. Written once so that the id and the slug can never
 * disagree about what a live organisation is, or about which columns ride
 * along with it.
 */
function organizationWithEntitlementsQuery(exec: Executor, key: SQL) {
  return exec
    .select({ organization: organizations, entitlements: entitlementColumns })
    .from(organizations)
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(and(key, isNull(organizations.deletedAt)))
    .limit(1);
}

/**
 * An organisation by its legacy slug.
 *
 * Kept for the addresses that still carry one: a CLI installed before
 * organisations were named by id, an old bookmark, an integration written
 * against the API. Nothing new is addressed this way, and nothing shows a
 * person the slug any more; see `organizationSlugFor`.
 */
export async function findOrganizationBySlugWithEntitlements(
  exec: Executor,
  slug: string,
): Promise<OrganizationWithEntitlements | null> {
  const [row] = await organizationBySlugWithEntitlementsQuery(exec, slug);
  return row ? withAwaitingPaidPlan(row) : null;
}

/**
 * An organisation by its id, with its entitlements: what `resolveOrg` reads
 * for every address the dashboard and a current CLI build.
 *
 * `null` for a value that is not a canonical UUID, without asking the
 * database: `organizations.id` is a `uuid` column, and PostgreSQL answers a
 * malformed one with an error rather than with no row, which would turn a
 * mistyped address into a 500.
 */
export async function findOrganizationByIdWithEntitlements(
  exec: Executor,
  orgId: string,
): Promise<OrganizationWithEntitlements | null> {
  if (!isUuid(orgId)) return null;
  const [row] = await organizationByIdWithEntitlementsQuery(exec, orgId);
  return row ? withAwaitingPaidPlan(row) : null;
}

/**
 * The row either lookup found, with the organisation's stored awaiting state
 * carried on its entitlements, so the id and the legacy slug answer alike.
 *
 * Stored on the organisation (migration 0037, `free-allowance.ts`), and only
 * ever set on a Free one; `resolveEntitlements` asks the plan again anyway. A
 * missing subscription row reads as Free everywhere, and so it does here: one
 * that is waiting is still waiting, so the answer carries the flag on the Free
 * row the migration would have written.
 */
function withAwaitingPaidPlan(row: OrganizationWithEntitlements): OrganizationWithEntitlements {
  const awaitingPaidPlan = row.organization.awaitingPaidPlanSince !== null;
  if (row.entitlements === null) {
    return {
      organization: row.organization,
      entitlements: awaitingPaidPlan ? { ...FREE_ROW, awaitingPaidPlan } : null,
    };
  }
  return {
    organization: row.organization,
    entitlements: { ...row.entitlements, awaitingPaidPlan },
  };
}

/** The row `entitlementsFromRow` reads a missing subscription as. */
const FREE_ROW: SubscriptionEntitlementRow = Object.freeze({
  plan: 'free',
  status: 'active',
  addonSaml: false,
  addonDirectorySync: false,
  limitOverrides: null,
  currentPeriodEnd: null,
});

export async function findOrganizationById(
  exec: Executor,
  orgId: string,
): Promise<Organization | null> {
  const [row] = await exec
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * The organisation a WorkOS Organization maps to, or null.
 *
 * What the sign-in callback's JIT join and the SSO deep link resolve through
 * (`.local/workos-auth.md` §2.3): WorkOS names an organisation by its own id,
 * and this is the only way back from that id to a tenant. A soft-deleted
 * organisation does not resolve — an SSO login must not JIT a member into an
 * organisation that has ended, any more than a slug lookup may route to one.
 *
 * ── Only a link made in the asking deployment's WorkOS environment ──
 * `workosClientId` is the asking deployment's `WORKOS_CLIENT_ID`, and a link
 * recorded with any other client id does not resolve (review round 2): a
 * WorkOS organisation id means something only in the environment that made
 * it, and a link written from local development against WorkOS Staging over
 * the production database must not let that Staging organisation's identity
 * provider just-in-time join anybody into a production organisation, or be
 * named on the sign-in confirmation as if it were this deployment's.
 *
 * Served by the index behind `organizations_workos_org_id_unique`.
 */
export async function findOrgByWorkosOrgId(
  exec: Executor,
  workosOrgId: string,
  workosClientId: string,
): Promise<Organization | null> {
  const [row] = await exec
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.workosOrgId, workosOrgId),
        eq(organizations.workosClientId, workosClientId),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The client id of the WorkOS environment this database belongs to
 * (`workos_home`, migration 0023), or `null` when no operator has recorded one.
 *
 * What turning SSO on — the only writer of a link — and switching an SSO
 * policy on are checked against: both refuse unless the deployment asking is
 * the one recorded here.
 */
export async function findWorkosHome(exec: Executor): Promise<string | null> {
  const [row] = await exec.select({ clientId: workosHome.clientId }).from(workosHome).limit(1);
  return row?.clientId ?? null;
}

/** What {@link setOrgWorkosOrgId} found, and whether it was the write that linked it. */
export interface OrgWorkosLink {
  organization: Organization;
  /**
   * `true` when this call wrote the link; `false` when the organisation was
   * already linked to exactly this WorkOS organisation, in exactly this WorkOS
   * environment — a retried or concurrent enable, which must answer as "already
   * on" and must not be audited a second time.
   */
  changed: boolean;
}

/**
 * Records the WorkOS Organization created for this organisation — the lazy link
 * (D7): only an organisation that turns SSO on ever gets one — together with
 * the WorkOS environment (`workosClientId`) it was created in.
 *
 * Set once. The write accepts an unlinked organisation; an organisation already
 * linked to this same id in this same environment is answered as it stands
 * (`changed: false`), so that a retried request is idempotent and a concurrent
 * one can tell it lost; anything else is refused rather than overwritten:
 *
 *  - `notFound` — no such organisation, or it was soft-deleted.
 *  - `conflict` — it is already linked to a *different* WorkOS Organization, or
 *    to this one through a different WorkOS environment (typically two admins
 *    enabling SSO at once: the second request created an orphan at WorkOS, and
 *    should delete it rather than re-point this tenant), or that WorkOS
 *    Organization already belongs to another organisation here
 *    (`organizations_workos_org_id_unique`).
 *
 *  - `forbidden` — `workosClientId` is not the environment this database
 *    belongs to (`workos_home`), or none is recorded (review round 2). Checked
 *    in the UPDATE's own predicate, so no caller that skipped the route's
 *    check can write a link no sign-in in this database's environment could
 *    ever come through.
 *
 * There is deliberately no way to clear or change the link. Re-pointing an
 * organisation's SSO at another WorkOS Organization re-points it at another
 * identity provider, and that is not something one ordinary write should be
 * able to do quietly. (It is also what keeps `organizations_sso_flags_need_link_check`
 * true for good once a flag is on: the link it depends on cannot go away.)
 *
 * The only caller passes an id its own `createOrganization` call returned in
 * the same request — never one a client supplied (PR #100, note 7) — and the
 * client id of the deployment that made the call.
 */
export async function setOrgWorkosOrgId(
  exec: Executor,
  orgId: string,
  workosOrgId: string,
  workosClientId: string,
): Promise<OrgWorkosLink> {
  const [row] = await exec
    .update(organizations)
    .set({ workosOrgId, workosClientId, updatedAt: new Date() })
    .where(
      and(
        eq(organizations.id, orgId),
        isNull(organizations.deletedAt),
        isNull(organizations.workosOrgId),
        exists(
          exec
            .select({ id: workosHome.id })
            .from(workosHome)
            .where(eq(workosHome.clientId, workosClientId)),
        ),
      ),
    )
    .returning()
    .catch((error: unknown) => {
      if (isUniqueViolation(error, WORKOS_ORG_ID_UNIQUE_CONSTRAINT)) {
        throw new RepositoryError(
          'conflict',
          'That WorkOS organization is already linked to another organisation.',
        );
      }
      throw error;
    });

  if (row) return { organization: row, changed: true };

  // The predicate matched nothing. Say which half of it failed: a missing
  // organisation, one already linked exactly so, and one linked elsewhere need
  // three different answers from the caller, and only the last should make it
  // clean up at WorkOS.
  const current = await findOrganizationById(exec, orgId);
  if (!current) throw new RepositoryError('notFound', 'Organisation not found.');
  if (current.workosOrgId === workosOrgId && current.workosClientId === workosClientId) {
    return { organization: current, changed: false };
  }
  if (current.workosOrgId === null && (await findWorkosHome(exec)) !== workosClientId) {
    throw new RepositoryError(
      'forbidden',
      'This database belongs to a different WorkOS environment, so no link is written from this one.',
    );
  }
  throw new RepositoryError(
    'conflict',
    'This organisation is already linked to a different WorkOS organization.',
  );
}

/** How many credentials an organisation's `sso_required` holds back, by kind. */
export interface AccessOutsideSso {
  /** Live browser sessions of non-owner members not issued by this organisation's SSO. */
  sessions: number;
  /**
   * Live CLI tokens of non-owner members, likewise — whichever organisation
   * the token was approved in: a CLI token acts as its user in every
   * organisation they belong to, so one approved elsewhere reaches this one
   * too (and is held back here all the same).
   */
  cliTokens: number;
}

/**
 * Counts the live credentials of an organisation's non-owner members that did
 * not come through its own single sign-on — the sessions and CLI tokens that
 * `sso_required` refuses for this organisation from the moment it is on
 * (`resolveOrg` checks every request). Shown by the settings after the switch,
 * so the person who flipped it knows how many people are about to be asked to
 * sign in again.
 *
 * Read-only, and not a setter of either SSO flag (the tripwire in
 * `workos-organizations.test.ts` lists it as such). "Live" is the cheap,
 * indexed half of the rule — not revoked, not past the absolute expiry; a
 * session that has idled out still counts until it is cleaned up, so this is an
 * upper bound. Owners are left out because they are exempt.
 */
export async function countNonSsoAccess(
  exec: Executor,
  params: { orgId: string; workosOrgId: string | null },
): Promise<AccessOutsideSso> {
  const member = and(
    eq(orgMembers.orgId, params.orgId),
    eq(orgMembers.status, 'active'),
    ne(orgMembers.role, 'owner'),
  );
  const [sessionRow] = await exec
    .select({ value: count() })
    .from(sessions)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, sessions.userId), member))
    .where(
      and(
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
        notThisSso(sessions.ssoWorkosOrgId, params.workosOrgId),
      ),
    );
  const [tokenRow] = await exec
    .select({ value: count() })
    .from(cliTokens)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, cliTokens.userId), member))
    .where(
      // No `cli_tokens.org_id = this organisation`: the token's organisation is
      // only where it was approved. `resolveOrg` lets a CLI token act as its
      // user in any organisation they are a member of, so every live token of
      // a member is a credential this requirement now holds back.
      and(
        isNull(cliTokens.revokedAt),
        or(isNull(cliTokens.expiresAt), gt(cliTokens.expiresAt, sql`now()`)),
        notThisSso(cliTokens.ssoWorkosOrgId, params.workosOrgId),
      ),
    );
  return { sessions: sessionRow?.value ?? 0, cliTokens: tokenRow?.value ?? 0 };
}

/** `column` is not `workosOrgId` — NULL included, which `<>` alone would drop. */
function notThisSso(column: AnyPgColumn, workosOrgId: string | null) {
  return workosOrgId === null ? sql`true` : or(isNull(column), ne(column, workosOrgId));
}

/**
 * The addresses of an organisation's active, non-owner members — what the SSO
 * settings compare with the verified domains, to warn before `sso_required`
 * goes on about members whose identity provider sign-in would be refused (an
 * SSO sign-in is believed only for a verified domain).
 *
 * Bounded by the seat ceiling in practice; `limit` is the backstop for a
 * Worker's memory, and the caller says when it was reached.
 */
export async function listMemberAddresses(
  exec: Executor,
  orgId: string,
  limit: number,
): Promise<string[]> {
  const rows = await exec
    .select({ email: users.email })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.status, 'active'),
        ne(orgMembers.role, 'owner'),
      ),
    )
    .orderBy(asc(orgMembers.createdAt))
    .limit(limit);
  return rows.map((row) => row.email);
}

/** The two SSO policy flags, as the settings route changes them. Absent means "leave it". */
export interface OrgSsoSettingsPatch {
  ssoRequired?: boolean | undefined;
  jitJoinEnabled?: boolean | undefined;
}

/** What {@link updateOrgSsoSettings} wrote, and what it replaced. */
export interface OrgSsoSettingsChange {
  organization: Organization;
  /**
   * Both flags as they stood under the lock, before the write — so the caller
   * audits only a flag that actually moved, and says which way it moved,
   * without a read of its own that a concurrent change could have overtaken.
   */
  previous: { ssoRequired: boolean; jitJoinEnabled: boolean };
}

/**
 * Sets an organisation's SSO policy: `sso_required`, and the just-in-time
 * opt-in (`jit_join_enabled`).
 *
 * The only writer of either column. The guards that decide *whether* the
 * caller may — an owner (`sso.manage`) to switch either on, an owner or admin
 * to switch one off, a browser session, the SAML add-on, this deployment's
 * WorkOS environment, and for `sso_required` an active connection and a
 * verified domain at WorkOS — are the settings route's
 * (`app/api/orgs/[orgSlug]/sso/route.ts`), because they need the request and
 * the provider. The route applies them to the state it asks for, not to the
 * state it read before this lock, so no interleaving can switch something on
 * past them. What this enforces is the one rule that is about the row:
 *
 *  - **Neither flag can be switched on without the WorkOS link** — `conflict`.
 *    Both are about the organisation's connection, and an organisation with no
 *    `workos_org_id` has none; `sso_required` there would refuse every member's
 *    every sign-in with nothing able to satisfy it. Checked under the row lock,
 *    and held by `organizations_sso_flags_need_link_check` underneath for any
 *    writer that is not this one.
 *  - Switching a flag **off** is always allowed, linked or not: relaxing a
 *    policy can never lock anybody out.
 *
 * Under the organisation's row lock (`FOR UPDATE`), the same lock an
 * invitation acceptance and a just-in-time join take — so a sign-in that is
 * deciding whether to admit somebody either sees this change or finishes
 * before it, never half of it. `notFound` for an organisation that is absent
 * or soft-deleted.
 */
export async function updateOrgSsoSettings(
  exec: Executor,
  orgId: string,
  patch: OrgSsoSettingsPatch,
): Promise<OrgSsoSettingsChange> {
  return exec.transaction(async (tx) => {
    const [current] = await tx
      .select({
        workosOrgId: organizations.workosOrgId,
        ssoRequired: organizations.ssoRequired,
        jitJoinEnabled: organizations.jitJoinEnabled,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .limit(1)
      .for('update');
    if (!current) throw new RepositoryError('notFound', 'Organisation not found.');

    const previous = { ssoRequired: current.ssoRequired, jitJoinEnabled: current.jitJoinEnabled };
    const turningOn = patch.ssoRequired === true || patch.jitJoinEnabled === true;
    if (turningOn && current.workosOrgId === null) {
      throw new RepositoryError(
        'conflict',
        'Single sign-on is not set up for this organisation, so its sign-in policy cannot be changed yet.',
      );
    }

    const [row] = await tx
      .update(organizations)
      .set({
        ...(patch.ssoRequired === undefined ? {} : { ssoRequired: patch.ssoRequired }),
        ...(patch.jitJoinEnabled === undefined ? {} : { jitJoinEnabled: patch.jitJoinEnabled }),
        updatedAt: new Date(),
      })
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .returning();
    // The row is locked, so it cannot have gone between the read and the write.
    if (!row) throw new RepositoryError('notFound', 'Organisation not found.');

    return { organization: row, previous };
  });
}

/**
 * The organisations a user can switch between, with the role they hold in each.
 *
 * The role comes back with the organisation because the switcher needs it to
 * decide what to show, and fetching it per organisation afterwards is the
 * N+1 this join exists to avoid.
 *
 * Ordered by name for the switcher, then by id — `organizations.name` carries
 * no unique constraint, and two personal organisations both left at their
 * default name would otherwise come back in whatever order the plan happened to
 * produce. The dashboard reloads this list on every lock, unlock and account
 * refresh, and treats the first row as the organisation to fall back to when a
 * route names none, so an unstable head is a shell that re-points itself
 * mid-session.
 */
export async function listOrganizationsForUser(
  exec: Executor,
  userId: string,
): Promise<OrganizationMembership[]> {
  const rows = await organizationsForUserQuery(exec, userId);
  return rows.map((row) => ({
    organization: row.organization,
    role: row.role,
    customRole: toCustomRole(row),
  }));
}

/** What `countOrganizationsHeldBy` found. */
export interface HeldOrganizations {
  /** How many, counted no further than the limit that was asked about. */
  total: number;
  /** The most recent of them, or `null` when the account holds none. */
  latestId: string | null;
}

/**
 * How many live organisations one account **created and is still in**, and the
 * newest of them.
 *
 * What a refused creation is filed against (`POST /api/orgs`). The free
 * allowance is counted differently, over every organisation the account
 * created whether or not it is still in it (`free-allowance.ts`): a place in
 * that count is not given back by leaving.
 *
 * Both halves of that are load-bearing, and each answers a way the other one
 * alone fails:
 *
 *  - **`created_by`**, so that being promoted to owner of somebody else's
 *    organisation does not spend this account's allowance. Ten colleagues
 *    handing somebody an owner seat must not stop them starting their own.
 *  - **an active membership**, so that a place can always be given back. The
 *    only way to release one is `DELETE /api/orgs/{org}`, which resolves
 *    through `resolveOrg` and answers 404 without a membership — so counting
 *    `created_by` alone meant an organisation you were removed from stood
 *    against your ceiling for ever, with no request you could make to clear it.
 *    A co-owner removing the creator from ten organisations was enough to stop
 *    that account creating an eleventh, permanently. What you can no longer
 *    reach is not something you are still holding.
 *
 * The membership join is what makes the ceiling coherent elsewhere, too: an
 * account with no memberships counts zero, so the organisation created at first
 * sign-in is within any cap by construction rather than by an exemption
 * somebody has to remember to keep correct.
 *
 * `status = 'active'` for the same reason the read exists at all — a suspended
 * member cannot delete the organisation either, so a suspension frees the place
 * rather than freezing it.
 *
 * Soft-deleted organisations are excluded, so deleting one frees a place. The
 * limit bounds the standing cost; only the rate limiter bounds the churn.
 *
 * ── Why a bounded row scan rather than `count(*)` ──
 * The caller is asking "is this account at its limit", which `LIMIT n` answers
 * exactly, and it can stop at `n` rows rather than aggregating over every
 * organisation an account has ever created. That is only true because
 * `organizations_creator_idx` supplies the rows in `id desc` order under the
 * `created_by` predicate — without it PostgreSQL has to find every candidate
 * row before it can sort, and the `LIMIT` saves nothing on the common path
 * where the account is under the ceiling. The ids are UUIDv7, so descending id
 * is descending creation time, and the first row is the one the refusal is
 * filed against — `audit_logs.org_id` being NOT NULL.
 */
export async function countOrganizationsHeldBy(
  exec: Executor,
  userId: string,
  limit: number,
): Promise<HeldOrganizations> {
  const rows = await organizationsHeldByQuery(exec, userId, limit);
  return { total: rows.length, latestId: rows[0]?.id ?? null };
}

/**
 * @internal Exported so `identity.test.ts` can assert that the count is joined
 * to membership, excludes soft-deleted rows and stops at the limit, without
 * needing a database.
 */
export function organizationsHeldByQuery(exec: Executor, userId: string, limit: number) {
  return (
    exec
      .select({ id: organizations.id })
      .from(organizations)
      // `org_members_org_user_unique` makes this at most one row per
      // organisation, so the join cannot inflate the count it is part of.
      .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
      .where(
        and(
          eq(organizations.createdBy, userId),
          eq(orgMembers.userId, userId),
          eq(orgMembers.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(desc(organizations.id))
      .limit(limit)
  );
}

/**
 * The slug an organisation is created with: its own id, written in base 36 and
 * padded to `ORGANIZATION_SLUG_MAX_LENGTH`.
 *
 * ── Why an organisation still has a slug at all ──
 * It is no longer anybody's identifier. Every address the dashboard builds,
 * every link the server mails and every path a current CLI calls names an
 * organisation by its id, and nothing shows a person the slug. The column
 * stays, `NOT NULL` and unique, because older clients still address
 * organisations by it (`resolveOrg` takes either), and dropping it is a
 * migration of its own for another day.
 *
 * ── Why this spelling ──
 * Derived rather than chosen, so creating an organisation asks for a name and
 * nothing else, and the name may be anything: two organisations called "Acme"
 * are two organisations. Derived from the id rather than from the name,
 * because the id is unique already and a bijection of it is unique by
 * construction: no lookup, no suffix search, no race between two people who
 * typed the same name, and nothing a stranger can learn by trying one.
 *
 * Base 36 because a 128-bit id is at most 25 base-36 digits, which is exactly
 * the organisation slug ceiling, so the result is a valid organisation slug:
 * lowercase letters and digits, no hyphens, never shaped like a UUID, and far
 * too long to collide with a reserved word. The padding makes every such slug
 * the same length, which says plainly that a person never picked it.
 */
export function organizationSlugFor(orgId: string): string {
  if (!isUuid(orgId)) throw new TypeError('An organisation slug is derived from a canonical UUID.');
  return BigInt(`0x${orgId.replaceAll('-', '')}`)
    .toString(36)
    .padStart(ORGANIZATION_SLUG_MAX_LENGTH, '0');
}

export interface ProvisionOrganizationParams {
  user: Pick<User, 'id' | 'email' | 'displayName'>;
  envelope: EnvelopeService;
  /**
   * Whether the free allowance applies here: this deployment takes payments,
   * so a Free organisation past it can be bought a plan. Where it cannot, no
   * organisation is created waiting, since nobody could buy the way out.
   *
   * Required, and deliberately not defaulted: the one bound on creating an
   * organisation is this rule, and a caller that forgot to say would silently
   * get either none or one nobody can satisfy.
   */
  freeAllowance: boolean;
  /**
   * Overrides the name derived from the user's profile. Any text the name
   * schema admits; names are not unique, and nothing treats them as if they
   * were. There is no slug to pass: see `organizationSlugFor`.
   */
  name?: string | undefined;
}

export interface ProvisionedOrganization {
  organization: Organization;
  membership: WrittenMemberRecord;
  /**
   * Whether the new organisation is past the account's free allowance and
   * waiting for a paid plan: the account already held two Free organisations
   * that work. The dashboard opens a waiting one on its plans page.
   */
  awaitingPaidPlan: boolean;
}

/**
 * Builds an organisation that can hold a secret: the organisation itself, an
 * owner membership for the caller, and an Org Master Key.
 *
 * ── Why it stops there, and does not seed a project ──
 * It used to create a `Default` project with the three standard environments and
 * an Env Data Key for each. That became wrong the moment migration 0013 made
 * `e2ee` the column default: the environments were written straight through this
 * function rather than through `createEnvironment`, so they took the new default
 * while still receiving the old server-wrapped `env_keys` and no
 * `env_data_keys`/`env_key_grants` at all. The product has a name for that state
 * and it is not a recoverable one — `env-key-notice.tsx` tells the user "no key
 * was ever recorded for it… nothing can repair it. Create a new environment and
 * delete this one." Every organisation created since that migration was born
 * holding three of them.
 *
 * It cannot be fixed by keying them here either, and that is the deeper reason
 * this is gone rather than repaired: an end-to-end encrypted environment's keys
 * are generated in a browser and sealed to a public key **this server has never
 * seen**. At sign-up there is no vault to seal to yet, so there is no honest key
 * this function could write. The first project is therefore created by
 * `POST …/projects` from an unlocked browser, which is the only place the
 * material can come from, and a new organisation opens on an empty projects
 * screen instead of on three environments nothing can be written to.
 *
 * Two paths reach this. The first is sign-up — a verified identity with no
 * membership anywhere gets one here, which is what makes the product usable
 * within a minute of signing up. The second is `POST /api/orgs`, where somebody
 * who already has an account starts a second organisation. The work is
 * identical; only the name differs. Neither path chooses a slug: one is
 * derived from the new id (`organizationSlugFor`).
 *
 * All of it in one transaction. A user who ends up with an organisation but no
 * Org Master Key is permanently broken — they cannot store a secret, and nothing
 * in the product can repair it without an operator going in by hand. That is the
 * single strongest argument for the transaction: partial state here is not an
 * inconvenience to retry past, it is an unrecoverable organisation.
 *
 * Note the ordering constraint honestly: the `EnvelopeService` calls are awaited
 * inside the transaction, so it is held open across CPU-bound cryptography. That
 * is acceptable *here* because it happens once per organisation, on a path
 * nobody waits on twice. Do not copy the shape into a request-serving path,
 * where holding a connection through key derivation is a self-inflicted
 * throughput limit. The environment keys are derived concurrently to keep the
 * window as short as it can be.
 *
 * ── The one bound on creating, and why it is enforced in here ──
 * No plan limits how many organisations an account holds: each paid one is
 * billed on its own. What is bounded is the free tier. An account's two open
 * Free organisations work; one created while it already holds two is created
 * waiting for a paid plan (`organizations.awaiting_paid_plan_since`, see
 * `free-allowance.ts`); and an account may hold only one that waits
 * (`AWAITING_ORGANIZATIONS_PER_ACCOUNT`). So creating is refused, with
 * `QuotaExceededError`, exactly when the new one would wait and the account
 * already holds one waiting: pay for it or delete it, then start another. That
 * is what keeps the number of Org Master Keys an account can mint without
 * paying bounded. None of it applies where the deployment takes no payments
 * (`freeAllowance: false`).
 *
 * Counted here, behind `lockAccount`, rather than by the caller. A count one
 * statement before this transaction is check-then-act: every concurrent request
 * that read "none waiting" would pass, and no constraint downstream can say "at
 * most one". The rate limiter is not a backstop either: Cloudflare's counters
 * are per-colo, and `consume` fails open when the binding is absent, which is
 * the documented state of a local or self-hosted deployment.
 */
export async function provisionOrganization(
  exec: Executor,
  params: ProvisionOrganizationParams,
): Promise<ProvisionedOrganization> {
  const { user, envelope } = params;

  return exec.transaction(async (tx) => {
    // First, and long before any key material: nothing below is worth doing
    // for a request that is about to be refused, and the lock has to be held
    // across the count *and* the insert for the count to mean anything.
    await lockAccount(tx, user.id);

    // Under the lock, so two creations (or a creation and a lapse) cannot both
    // read the same count. A new organisation is Free, so it waits exactly when
    // the account already holds two open Free ones; and it may not be made at
    // all while one of the account's organisations already waits.
    const awaitingPaidPlan =
      params.freeAllowance &&
      (await countOpenFreeOrganizations(tx, user.id, {
        limit: FREE_ORGANIZATIONS_PER_ACCOUNT,
      })) >= FREE_ORGANIZATIONS_PER_ACCOUNT;
    if (
      awaitingPaidPlan &&
      (await countAwaitingOrganizations(tx, user.id)) >= AWAITING_ORGANIZATIONS_PER_ACCOUNT
    ) {
      throw new QuotaExceededError(
        'This account already has an organisation waiting for a paid plan.',
      );
    }

    const now = new Date();
    const orgId = uuidv7();

    const [organization] = await tx
      .insert(organizations)
      .values({
        id: orgId,
        name: params.name?.trim() || defaultOrganizationName(user),
        // Unique because the id is: see `organizationSlugFor`. No lookup first,
        // so there is no window between a check and this insert to lose.
        slug: organizationSlugFor(orgId),
        createdBy: user.id,
        awaitingPaidPlanSince: awaitingPaidPlan ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      // Unreachable short of a slug somebody chose before slugs were derived
      // that happens to spell a fresh id in base 36. Mapped to `conflict` all
      // the same, so a failure nobody can explain is at least a 409 that a
      // second attempt (with a new id) gets past, rather than a 500.
      .catch(rethrowSlugCollision);
    // A single-row `INSERT … RETURNING` either returns its row or throws, so this
    // and the checks below are unreachable. They exist because
    // `noUncheckedIndexedAccess` is on and a `!` here would hide a genuine
    // failure if that ever stopped being true.
    if (!organization) throw new Error('Organisation insert returned no row.');

    const membership = await addMember(tx, {
      orgId,
      userId: user.id,
      role: 'owner',
      invitedBy: null,
    });

    const orgKey = await envelope.createOrgKey(orgId);
    const [orgKeyRow] = await tx
      .insert(orgKeys)
      .values({
        id: uuidv7(),
        orgId,
        version: orgKey.version,
        wrappedKey: orgKey.ciphertext,
        wrapIv: orgKey.iv,
        rootKeyVersion: orgKey.rootKeyVersion,
        // Recorded from the key that was actually produced rather than left to
        // the column default, so a future algorithm change cannot silently
        // mislabel rows written during the changeover.
        algorithm: orgKey.algorithm,
        createdAt: now,
      })
      .returning();
    if (!orgKeyRow) throw new Error('Organisation key insert returned no row.');

    // Inside the same transaction, so an organisation and its subscription
    // commit together or not at all. The alternative — creating the row lazily
    // on first read — makes every entitlement lookup a left join with a
    // fallback, and a fallback that duplicates the Free plan is a fallback that
    // will one day disagree with it.
    await createFreeSubscription(tx, orgId);

    return { organization, membership, awaitingPaidPlan };
  });
}

export interface OrganizationPatch {
  name?: string | undefined;
}

/**
 * Renames an organisation. The name only: everything else about an
 * organisation has its own path with its own authorization check, and the slug
 * is not anybody's to change (see `organizationSlugFor`).
 */
export async function updateOrganization(
  exec: Executor,
  orgId: string,
  patch: OrganizationPatch,
): Promise<Organization> {
  if (patch.name === undefined) {
    const current = await findOrganizationById(exec, orgId);
    if (!current) throw new RepositoryError('notFound', 'Organisation not found.');
    return current;
  }

  const [row] = await exec
    .update(organizations)
    .set({ name: patch.name, updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .returning();

  if (!row) throw new RepositoryError('notFound', 'Organisation not found.');
  return row;
}

/**
 * Soft-deletes an organisation.
 *
 * One column, and everything inside stops resolving at once: every read joins
 * through `organizations` with a `deleted_at is null` filter, so projects,
 * environments and secrets become unreachable without touching their rows —
 * they remain what the audit log points at. The wrapped keys remain too, and
 * remain wrapped; nothing here needs, or touches, key material. Thirty days
 * later the deleted-data purge erases all of it (`deleted-data.ts`).
 *
 * Idempotent, and deliberately without a last-owner style guard: the caller
 * decides whether an organisation may die (account deletion deletes the ones
 * the leaver was alone in), and a repository second-guessing that would need
 * the caller's context to do it correctly.
 */
export async function softDeleteOrganization(exec: Executor, orgId: string): Promise<void> {
  const now = new Date();
  await exec
    .update(organizations)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)));
}

/**
 * What a personal organisation is named after when the account has no display
 * name: the local part of its email address.
 *
 * The local part is the closest thing to a name available at first login. A
 * `+tag` is dropped because it is a routing detail of the address rather than
 * part of who the person is.
 */
export function personalOrganizationNameSeed(email: string): string {
  const at = email.indexOf('@');
  const localPart = at === -1 ? email : email.slice(0, at);
  const tag = localPart.indexOf('+');

  return tag === -1 ? localPart : localPart.slice(0, tag);
}

/**
 * Serialises one account's organisation creations against each other.
 *
 * The lock is taken on the *account* row rather than on anything the
 * transaction is about to write, for the same reason `lockForChange`
 * locks the organisation rather than the member being changed: "at most ten" is
 * a property of a set, and locking the rows a transaction writes serialises
 * nothing when each writes a different row. Two concurrent creations insert two
 * different organisations, each counts nine, and both commit — and no
 * constraint downstream disagrees, because none of them can express a ceiling
 * across rows. `users` is the only row the two have in common, so holding it
 * forces the second to count again under the first one's committed effect.
 *
 * The honest cost: the lock is held for the rest of the transaction, which in
 * `provisionOrganization` means across the Org Master Key derivation — so a second
 * creation from the same account waits the first one out. That is the intent —
 * one account may not mint Org Master Keys in parallel — and the contention is
 * confined to that account, since nobody else has any reason to touch this row.
 * The other writer of it is the sign-in callback's linking pass, so a sign-in
 * landing mid-creation for the same person waits too, on a request that has
 * just spent far longer verifying its identity with the provider.
 *
 * A soft-deleted account is filtered out rather than locked. It cannot
 * authenticate, so this is unreachable from the two callers; if it ever became
 * reachable, `notFound` is a better ending than provisioning an organisation
 * for a row on its way out.
 */
async function lockAccount(exec: Executor, userId: string): Promise<void> {
  const [account] = await accountLockQuery(exec, userId);
  if (!account) throw new RepositoryError('notFound', 'Account not found.');
}

/**
 * @internal Exported so `identity.test.ts` can assert that the serialisation is
 * a `SELECT … FOR UPDATE` on one account row, without needing a database to
 * demonstrate the race it closes.
 */
export function accountLockQuery(exec: Executor, userId: string) {
  return exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
    .for('update');
}

/**
 * The organisation is named after the person, because at first login that is the
 * only meaningful name available. Renaming it is one field in settings.
 *
 * Truncated to the limit the API enforces on a name somebody types. The source
 * here is a display name from an identity provider, which arrives at whatever
 * length that provider allows — and an organisation created at sign-up that the
 * settings page then refuses to save would be a rule the product breaks on the
 * user's behalf and then blames them for.
 */
function defaultOrganizationName(user: Pick<User, 'email' | 'displayName'>): string {
  const source =
    user.displayName?.trim() ||
    personalOrganizationNameSeed(user.email) ||
    FALLBACK_ORGANIZATION_NAME;
  return truncateName(source, ORGANIZATION_NAME_MAX_LENGTH) || FALLBACK_ORGANIZATION_NAME;
}

/**
 * A slug collision on insert, as a conflict the caller can retry rather than
 * the 500 an unmapped driver error would produce. See `provisionOrganization`
 * for why it does not happen.
 */
function rethrowSlugCollision(error: unknown): never {
  if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
    throw new RepositoryError('conflict', 'The organisation could not be created. Try again.');
  }
  throw error;
}

/**
 * @internal Exported so `identity.test.ts` can assert that the membership join
 * carries the tenancy predicate, without needing a database to prove it.
 */
export function organizationsForUserQuery(exec: Executor, userId: string) {
  return (
    exec
      .select({ organization: organizations, role: orgMembers.role, ...CUSTOM_ROLE_COLUMNS })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      // The narrowing, on the one join every membership read shares — LEFT, so a
      // member without a custom role (almost everybody) is still listed.
      .leftJoin(customRoles, customRoleJoin())
      .where(
        and(
          eq(orgMembers.userId, userId),
          eq(orgMembers.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(asc(organizations.name), asc(organizations.id))
  );
}
