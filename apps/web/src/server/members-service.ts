import type {
  AccessLevel,
  CustomRole,
  GrantReach,
  GridEnvironment,
  OrgRole,
} from '@xecret/core/authz';
import {
  AuthorizationError,
  canDefineCustomRole,
  effectiveRole,
  grantReach,
  grantWithinAuthority,
  heldGrantsWithinAuthority,
  removalWithinAuthority,
  resolveAccessLevel,
  roleDefaultAccessLevel,
  roleWithinAuthority,
  widensHolder,
} from '@xecret/core/authz';
import type { Database, InvitationGrantSeed } from '@xecret/db';
import {
  FieldConflictError,
  findEnvironmentBySlug,
  findProjectBySlug,
  RepositoryError,
} from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  MemberGrant,
  OrganizationEnvironment,
  RepositoryErrorCode,
} from '@xecret/db/repositories';
import type { AuditErrorReason } from '@xecret/core/audit';
import type { Principal } from './actor';
import { errors } from './errors';
import { toGrantContext, toMembership } from './tenancy';
import type { OrgScope, StoredRoleAndStatus } from './tenancy';

/**
 * Member management — the pieces the member and invitation routes share.
 *
 * Three concerns live here rather than in the routes:
 *
 *  1. **You can't hand out what you don't hold.** `can()` answers whether a
 *     role may manage members at all; it does not compare the caller with what
 *     they are conferring. The comparison is made in `@xecret/core/authz` —
 *     `roleWithinAuthority` for roles, `authority.ts` for levels — and this
 *     module wraps it for the routes: it adapts the stored rows
 *     (`toMembership`), and turns a refusal into the same `AuthorizationError`
 *     `can()`'s denials raise, so the route files it as a `denied` audit
 *     record and the client gets the same 403.
 *
 *     What that bounds depends on what restricts the caller. A custom role
 *     contains its holder: its ceiling and action list are measured for the
 *     roles they appoint and the levels they grant alike. An explicit grant on
 *     a plain admin is narrower — it restricts that admin's own access and
 *     bounds what they grant, mint or unblock directly, but roles are measured
 *     by role, so it does not stop them appointing another plain admin.
 *
 *  2. **The session requirement.** Inviting someone mints a credential (the
 *     invitation token), and the standing rule from the CLI authorization flow
 *     applies: a bearer credential may not mint further credentials. Member
 *     mutations therefore require the browser session, where CSRF and the vault
 *     gate also live.
 *
 *  3. **The effective-access computation** behind "what can this member
 *     actually reach?" — which calls the same `resolveAccessLevel` the
 *     authorization engine uses. A preview computed by a second implementation
 *     would eventually disagree with enforcement, and a preview that lies is
 *     worse than none.
 */

/** The session principal, or a refusal for a credential that manages nobody. */
export function requireSessionPrincipal(
  principal: Principal,
): Extract<Principal, { kind: 'user' }> {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Managing members requires a browser session, not a token.');
  }
  return principal;
}

/** The caller's own membership. Service tokens are refused by `can()` before this. */
export function requireMembership(scope: OrgScope): StoredAuthorizationContext {
  if (scope.membership === undefined) {
    throw errors.forbidden('This credential holds no membership in the organisation.');
  }
  return scope.membership;
}

/**
 * The part of the caller's membership that decides whose role they may touch:
 * their built-in role and, when they hold one, the custom role narrowing it.
 */
export type RoleAuthority = Pick<StoredAuthorizationContext, 'role' | 'customRole'>;

/**
 * The refusal every check below raises: `forbidden`, with a fixed message.
 *
 * An `AuthorizationError` — the exception `can()`'s denials travel as — rather
 * than an `ApiError`, so that the route files it through the same path as a
 * capability denial (`auditingDenials`, in `@xecret/core/authz`), and a
 * caller probing past their authority leaves the same trail as one probing
 * past their role. The route boundary answers it exactly as it would
 * `errors.forbidden(message)`.
 */
function refuse(message: string): never {
  throw new AuthorizationError({ allowed: false, reason: 'forbidden', message });
}

const ROLE_ABOVE_AUTHORITY = 'You cannot manage a role above your own.';
const GRANT_ABOVE_AUTHORITY = 'You cannot grant more access than you hold.';
const OWN_GRANTS = 'You cannot change your own access grants.';
const HELD_GRANTS_ABOVE_AUTHORITY = 'This member holds access grants beyond your own.';

/**
 * Refuses a change that touches a role beyond the caller's own authority.
 *
 * Applied to the target's *current* role when managing an existing member, and
 * to the *new* role when assigning one. The message does not name either role:
 * it is a fixed string, and the caller already knows what they asked for.
 *
 * ── Measured by what the caller's role leaves them ──
 * The predicate is `roleWithinAuthority`: for a caller without a custom role it
 * is exactly the rank rule (`canAssignRole`) — no role above your own — and for
 * one with a custom role it also asks whether the caller holds every
 * capability, and every default level, the role would confer. An admin-based
 * custom role narrowed to member management passes `can()` for `member.update`
 * exactly as an admin would; measured by rank alone, it could invite a plain
 * admin, or promote a developer to one, and act through them.
 *
 * Explicit grants on the caller play no part: an admin an owner held to `read`
 * on production still appoints admins. See `roleWithinAuthority`.
 *
 * It takes the membership rather than a role so that this cannot be got wrong
 * at a call site: a route that passes `membership.role` does not compile, where
 * one that forgot the custom role would compile and escalate.
 *
 * The subject's side stays their stored `role`. It is never lower than their
 * effective one, so it is the stricter thing to be measured against — an admin
 * may not touch an owner however narrowly that owner is currently scoped.
 */
export function assertRoleAuthority(actor: RoleAuthority, subjectRole: OrgRole): void {
  if (!roleWithinAuthority(actor, subjectRole)) refuse(ROLE_ABOVE_AUTHORITY);
}

/**
 * Refuses an explicit grant above what the caller holds where it lands
 * (`grantWithinAuthority`: the lowest level they resolve to across the grant's
 * reach, which for a project-wide row includes the project's production).
 *
 * The other half of "you can't hand out what you don't hold": a role is
 * measured by `assertRoleAuthority`, a grant by this.
 *
 * Universal, not only for callers holding a custom role. An owner or admin
 * with nothing written against them resolves to `admin` everywhere and notices
 * nothing. One restricted by a custom role's ceiling can grant only what the
 * ceiling leaves them. One restricted by an explicit grant on themselves can
 * grant, directly, only what that grant leaves them — which bounds what they
 * write, not whom they may appoint: such an admin can still make another
 * plain admin, who holds what the grant withheld (see `assertRoleAuthority`).
 *
 * `none` always passes: taking access away confers nothing.
 */
export function assertGrantWithinAuthority(
  actor: StoredAuthorizationContext,
  level: AccessLevel,
  reach: GrantReach,
): void {
  if (!grantWithinAuthority(toGrantContext(actor), level, reach)) refuse(GRANT_ABOVE_AUTHORITY);
}

/**
 * Refuses removing a grant when what the member falls back to would raise them
 * above what the caller holds, at any place the row took effect
 * (`removalWithinAuthority`).
 *
 * Unchecked, a caller capped at `none` on production could grant production by
 * deletion exactly as the level check on PUT stops them granting it by
 * writing — a developer's explicit `none` on production, removed, lets a
 * project-wide `write` take over there. The member is measured as active
 * whatever their status: a row removed while they are suspended is still gone
 * when they are reinstated.
 *
 * `member` is the target's record and `memberGrants` their whole grant list —
 * both the enforcement path's inputs, so "what they fall back to" is what
 * `can()` would resolve for them the moment the row is gone.
 */
export function assertRemovalWithinAuthority(
  actor: StoredAuthorizationContext,
  member: StoredRoleAndStatus,
  memberGrants: readonly MemberGrant[],
  reach: GrantReach,
): void {
  if (!removalWithinAuthority(toGrantContext(actor), toMembership(member, memberGrants), reach)) {
    refuse(GRANT_ABOVE_AUTHORITY);
  }
}

/**
 * Refuses a change that would switch on grant rows the caller could not have
 * written themselves (`heldGrantsWithinAuthority`).
 *
 * Asked by the member route of a reinstatement — every row a suspended member
 * holds is dormant until then — and of a role change that gains the member
 * capabilities, which turns a row the old role could only read through into
 * one the new role writes through. Without it, an owner suspends a developer
 * holding production `write`, and an admin capped at `none` on production
 * reinstates them; or promotes a viewer an owner granted production `write` to
 * developer. Either hands out production access through somebody who does not
 * hold it.
 *
 * Owners and admins with nothing written against them resolve to `admin`
 * everywhere and are never refused. One held down by an explicit grant on
 * themselves — an owner included — is held to it here exactly as on a grant
 * written directly; an owner can lift their own restriction first.
 */
export function assertHeldGrantsWithinAuthority(
  actor: StoredAuthorizationContext,
  memberGrants: readonly MemberGrant[],
  grid: readonly GridEnvironment[],
): void {
  if (!heldGrantsWithinAuthority(toGrantContext(actor), memberGrants, grid)) {
    refuse(HELD_GRANTS_ABOVE_AUTHORITY);
  }
}

/**
 * Refuses a caller changing their own grants — unless they are an owner.
 *
 * The same reasoning as "you cannot change your own role": a restriction its
 * holder can lift is not a restriction. Without this, an admin an owner held to
 * `read` on production deletes the grant that says so, or writes a wider one
 * over it, and is an unrestricted admin again.
 *
 * ── Why owners are the exception ──
 * An owner restricting themselves — so a routine mistake cannot reach
 * production — is a practice worth keeping, and it needs a way back: a sole
 * owner who could not lift their own restriction would need an owner who does
 * not exist. It is safe because an owner cannot hold a custom role, so the
 * most any change to their own grants can give them is the owner role's own
 * default — authority the role already carries. The routes measure an owner
 * acting on themselves against that, not against the restriction being lifted.
 *
 * Effective owner, not stored owner: the two are the same today (the database
 * refuses a custom role on an owner), and checking the effective role keeps it
 * true if that ever changes.
 */
export function assertMayChangeOwnGrants(actor: RoleAuthority): void {
  if (effectiveRole(actor.role, actor.customRole) !== 'owner') refuse(OWN_GRANTS);
}

/* ── Custom roles ──────────────────────────────────────────────────────── */

const NARROWED_DEFINER = 'Only an owner or admin who holds no custom role can define roles.';
const BASE_ABOVE_AUTHORITY = 'You cannot define a role on a base above your own.';
const HOLDER_ABOVE_AUTHORITY = 'This role is held by somebody whose role is above your own.';
const HOLDER_GRANTS_ABOVE_AUTHORITY =
  'This change would widen a member who holds access grants beyond your own.';

/**
 * Refuses defining, editing or deleting a custom role on `baseRole` unless the
 * caller may (`canDefineCustomRole`): they hold no custom role themselves, and
 * the base is not `owner` and not above their own role.
 *
 * Two messages, because the two refusals are fixed by different people: one by
 * whoever narrowed the caller, the other by picking a lower base.
 */
export function assertMayDefineCustomRole(actor: RoleAuthority, baseRole: OrgRole): void {
  if (canDefineCustomRole(actor, baseRole)) return;
  refuse(actor.customRole !== undefined ? NARROWED_DEFINER : BASE_ABOVE_AUTHORITY);
}

/**
 * Refuses an edit of a custom role's definition beyond the caller's authority,
 * measured against the role as it stands and every member who holds it.
 *
 *  1. **Both bases** pass `canDefineCustomRole`: the one being replaced as
 *     well as the new one, so an admin cannot take over an admin-based role
 *     somebody else defined and then only have their *new* base measured.
 *  2. **Every holder** passes `roleWithinAuthority` on their stored role.
 *     Editing a role changes each holder's authority, and the caller may not
 *     change the authority of somebody they could not otherwise manage — the
 *     same rule as `assertRoleAuthority` on a member's current role.
 *  3. **Every holder the edit widens** (`widensHolder`: a capability gained, or
 *     a ceiling or default raised) passes `heldGrantsWithinAuthority` over the
 *     grant rows they hold. Widening a role switches on rows its ceiling held
 *     down or its list made read-only, exactly as a built-in role change that
 *     gains capabilities does, and is refused unless the caller could have
 *     written every one of them.
 *
 * Measured per holder, because the same edit widens members differently: an
 * admin holding a developer-based role and a viewer holding it resolve through
 * different effective roles.
 */
export function assertCustomRoleEditWithinAuthority(
  actor: StoredAuthorizationContext,
  before: CustomRole,
  after: CustomRole,
  holders: readonly { role: OrgRole; grants: readonly MemberGrant[] }[],
  grid: readonly GridEnvironment[],
): void {
  assertMayDefineCustomRole(actor, before.baseRole);
  assertMayDefineCustomRole(actor, after.baseRole);

  for (const holder of holders) {
    if (!roleWithinAuthority(actor, holder.role)) refuse(HOLDER_ABOVE_AUTHORITY);
  }

  const measured = toGrantContext(actor);
  for (const holder of holders) {
    const widened = widensHolder(
      { role: holder.role, customRole: before },
      { role: holder.role, customRole: after },
    );
    if (widened && !heldGrantsWithinAuthority(measured, holder.grants, grid)) {
      refuse(HOLDER_GRANTS_ABOVE_AUTHORITY);
    }
  }
}

/**
 * Refuses moving a member onto a custom role, off theirs, or from one to
 * another, beyond the caller's authority.
 *
 *  - The member's stored role must be within the caller's authority
 *    (`assertRoleAuthority`): assigning only narrows, but unassigning returns
 *    the member to the whole of that role, and the rule is the same either way
 *    — you do not change somebody you could not otherwise manage.
 *  - A change that widens the member (`widensHolder` — unassigning, or a swap
 *    to a role with more actions or a higher ceiling) must pass
 *    `heldGrantsWithinAuthority` over their grant rows, since it switches on
 *    rows the old role held down.
 *
 * `member` is the member as read under the organisation lock, custom role
 * included; `next` is the role they are moving onto, or `undefined` for none.
 */
export function assertCustomRoleChangeWithinAuthority(
  actor: StoredAuthorizationContext,
  member: StoredRoleAndStatus,
  next: CustomRole | undefined,
  grants: readonly MemberGrant[],
  grid: readonly GridEnvironment[],
): void {
  assertRoleAuthority(actor, member.role);

  const widened = widensHolder(
    { role: member.role, customRole: member.customRole },
    { role: member.role, customRole: next },
  );
  if (widened) assertHeldGrantsWithinAuthority(actor, grants, grid);
}

/**
 * Refuses an invitation whose initial grants exceed what the inviter holds.
 *
 * Each seed is measured at the level acceptance will actually write: the one
 * it names, or — for a seed that names none — the invited role's
 * *non-production* default, which acceptance writes even on a production
 * environment (see `applyInitialGrants`). Measuring an unstated level as "the
 * role default for this environment" would under-count exactly there. Each
 * seed's reach is read off the organisation's grid (`grantReach`).
 */
export function assertInvitationGrantsWithinAuthority(
  actor: StoredAuthorizationContext,
  invitedRole: OrgRole,
  seeds: readonly InvitationGrantSeed[],
  grid: readonly OrganizationEnvironment[],
): void {
  const fallback = roleDefaultAccessLevel(invitedRole, false);
  for (const seed of seeds) {
    assertGrantWithinAuthority(
      actor,
      seed.accessLevel ?? fallback,
      grantReach(seed.projectId, seed.environmentId, grid),
    );
  }
}

/**
 * Maps a `RepositoryError` from the membership layer onto the API vocabulary.
 * The messages are the repository's own — fixed literals, never derived from
 * the request — so passing them through leaks nothing.
 */
export function mapMembershipError(cause: unknown): never {
  // A conflict about one field — a role name another role holds — is answered
  // on that field, so the form can say so beside the input.
  if (cause instanceof FieldConflictError) throw errors.conflictOn(cause.field, cause.message);
  if (cause instanceof RepositoryError) {
    switch (cause.code) {
      case 'notFound':
        throw errors.notFound(cause.message);
      case 'conflict':
        throw errors.conflict(cause.message);
      case 'lastOwner':
      case 'seatLimit':
        // Both are states of the organisation, not faults in the request: the
        // same request succeeds once a seat frees up or a second owner exists.
        throw errors.conflict(cause.message);
      case 'invalid':
        throw errors.badRequest(cause.message);
      case 'immutable':
        throw errors.badRequest(cause.message);
    }
  }
  throw cause;
}

/** The audit reason each repository refusal is filed under. */
const REFUSAL_REASON: Readonly<Record<RepositoryErrorCode, AuditErrorReason>> = {
  conflict: 'conflict',
  lastOwner: 'conflict',
  seatLimit: 'conflict',
  quotaExceeded: 'quotaExceeded',
  notFound: 'notFound',
  invalid: 'invalidInput',
  immutable: 'invalidInput',
  // Raised today only by the identity-linking pass, for an address its
  // provider has not verified — a credential that proves too little. No
  // membership or custom-role write raises it; it is here because the map is
  // exhaustive, so a new code has to be decided rather than filed as nothing.
  forbidden: 'invalidCredentials',
};

/**
 * `mapMembershipError`, filing a record of the refusal first.
 *
 * For the custom-role writes, where the refusals a repository raises — a name
 * already taken, a role still held, an owner being handed one — are exactly
 * the attempts an audit trail should show, not only the ones that were
 * forbidden. `file` receives the category, never the message: the category is
 * what alerting groups by (see `AuditBuilder.error`).
 */
export function mapAuditedMembershipError(
  file: (reason: AuditErrorReason) => void,
): (cause: unknown) => never {
  return (cause) => {
    if (cause instanceof RepositoryError) file(REFUSAL_REASON[cause.code]);
    return mapMembershipError(cause);
  };
}

/** Where a resolved level came from, for the preview UI to explain itself. */
export type AccessSource = 'suspended' | 'environment-grant' | 'project-grant' | 'role-default';

export interface EffectiveEnvironmentAccess {
  name: string;
  slug: string;
  isProduction: boolean;
  level: AccessLevel;
  source: AccessSource;
}

export interface EffectiveProjectAccess {
  name: string;
  slug: string;
  /**
   * The level for project-scoped actions, which leave production out. Deleting
   * the project also needs `environment.delete` on each of its environments —
   * the per-environment levels below.
   */
  projectLevel: AccessLevel;
  environments: EffectiveEnvironmentAccess[];
}

/**
 * The complete answer to "what can this member reach, and why?".
 *
 * Levels come from `resolveAccessLevel` — the enforcement path — and only the
 * *attribution* is computed here, by looking at which grant row matched. The
 * two walks agree by construction because they read the same rows in the same
 * precedence order; the tests pin that.
 *
 * `member` carries the custom role along with the built-in one, because the
 * engine applies it — its base role to the defaults, its ceiling to every
 * level — and a preview built without it would show the unnarrowed level: the
 * one thing a preview must never do. Pass the repository's member record
 * whole; it carries `customRole` from the same join that loaded the role.
 *
 * The attribution is of the rule that *matched*: a grant capped by a custom
 * role's ceiling is still reported as that grant, at the capped level.
 */
export function effectiveAccess(
  member: StoredRoleAndStatus,
  grants: readonly MemberGrant[],
  environments: readonly OrganizationEnvironment[],
): EffectiveProjectAccess[] {
  const membership = toMembership(member, grants);

  const byProject = new Map<
    string,
    { project: OrganizationEnvironment['project']; rows: OrganizationEnvironment[] }
  >();
  for (const environment of environments) {
    const entry = byProject.get(environment.project.id);
    if (entry) {
      entry.rows.push(environment);
    } else {
      byProject.set(environment.project.id, { project: environment.project, rows: [environment] });
    }
  }

  return [...byProject.values()].map(({ project, rows }) => ({
    name: project.name,
    slug: project.slug,
    projectLevel: resolveAccessLevel({ ...membership, isProduction: false }, project.id, null),
    environments: rows.map((environment) => ({
      name: environment.name,
      slug: environment.slug,
      isProduction: environment.isProduction,
      level: resolveAccessLevel(
        { ...membership, isProduction: environment.isProduction },
        project.id,
        environment.id,
      ),
      source: accessSource(member, grants, project.id, environment.id),
    })),
  }));
}

/** Which rule decided — mirroring the precedence inside `resolveAccessLevel`. */
function accessSource(
  member: Pick<StoredRoleAndStatus, 'status'>,
  grants: readonly MemberGrant[],
  projectId: string,
  environmentId: string,
): AccessSource {
  if (member.status === 'suspended') return 'suspended';

  if (grants.some((g) => g.projectId === projectId && g.environmentId === environmentId)) {
    return 'environment-grant';
  }
  if (grants.some((g) => g.projectId === projectId && g.environmentId === null)) {
    return 'project-grant';
  }
  return 'role-default';
}

/**
 * Resolves an invitation's access selections from slugs to ids.
 *
 * Done at *invitation* time rather than acceptance: the inviter is the one who
 * can act on "no such project", and ids are what survive a rename between the
 * invitation and its acceptance (slugs are immutable today, but a snapshot
 * should not depend on that staying true). Anything deleted before acceptance
 * is skipped there — the deny-by-default rows cover whatever replaced it.
 *
 * Failures are field errors carrying the *position* of the bad selection,
 * never the slug itself: this API does not echo request input, and the dialog
 * that sent the selection can point at the row from the index alone.
 */
export async function resolveInvitationGrants(
  db: Database,
  orgId: string,
  selections: readonly {
    projectSlug: string;
    environmentSlug: string | null;
    accessLevel?: AccessLevel | undefined;
  }[],
): Promise<InvitationGrantSeed[]> {
  const projectIds = new Map<string, string>();
  const seeds: InvitationGrantSeed[] = [];
  const seen = new Set<string>();

  for (const [index, selection] of selections.entries()) {
    let projectId = projectIds.get(selection.projectSlug);
    if (projectId === undefined) {
      const project = await findProjectBySlug(db, orgId, selection.projectSlug);
      if (!project) {
        throw errors.validation([
          { field: `grants[${index}].projectSlug`, message: 'No such project.' },
        ]);
      }
      projectId = project.id;
      projectIds.set(selection.projectSlug, projectId);
    }

    let environmentId: string | null = null;
    if (selection.environmentSlug !== null) {
      const environment = await findEnvironmentBySlug(
        db,
        orgId,
        projectId,
        selection.environmentSlug,
      );
      if (!environment) {
        throw errors.validation([
          { field: `grants[${index}].environmentSlug`, message: 'No such environment.' },
        ]);
      }
      environmentId = environment.id;
    }

    const key = `${projectId}/${environmentId ?? '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The level rides along only when the caller named one; omitting it is
    // what makes acceptance fall back to the invited role's default, and an
    // explicit `undefined` in the jsonb would not.
    seeds.push({
      projectId,
      environmentId,
      ...(selection.accessLevel === undefined ? {} : { accessLevel: selection.accessLevel }),
    });
  }

  return seeds;
}
