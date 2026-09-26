import type { AccessLevel, Membership, OrgRole } from '@xecret/core/authz';
import {
  compareAccessLevel,
  effectiveRole,
  resolveAccessLevel,
  roleDefaultAccessLevel,
  roleWithinAuthority,
} from '@xecret/core/authz';
import type { Database, InvitationGrantSeed } from '@xecret/db';
import { findEnvironmentBySlug, findProjectBySlug, RepositoryError } from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  MemberGrant,
  MemberListEntry,
  OrganizationEnvironment,
} from '@xecret/db/repositories';
import type { Principal } from './actor';
import { errors } from './errors';
import { toGrantContext } from './tenancy';
import type { OrgScope } from './tenancy';

/**
 * Member management — the pieces the member and invitation routes share.
 *
 * Three concerns live here rather than in the routes:
 *
 *  1. **You can't hand out what you don't hold.** `can()` answers whether a
 *     role may manage members at all; it does not compare the caller with what
 *     they are conferring. Without that second check, an admin could mint an
 *     owner and act through them — or, holding a custom role, mint the plain
 *     admin their own role was narrowed from. Roles are measured by
 *     `roleWithinAuthority` from `@xecret/core/authz`, applied to both sides of
 *     every change: the role being handed out *and* the role currently held by
 *     the member being touched. Grant levels are measured against the level
 *     the caller resolves to on the same resource (`assertGrantWithinAuthority`).
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
 * Refuses a change that touches a role beyond the caller's own authority.
 *
 * Applied to the target's *current* role when managing an existing member, and
 * to the *new* role when assigning one. The message does not name either role:
 * it is a fixed string, and the caller already knows what they asked for.
 *
 * ── Measured by what the caller holds, and takes the membership ──
 * The predicate is `roleWithinAuthority`: for a caller without a custom role it
 * is exactly the rank rule (`canAssignRole`) — no role above your own — and for
 * one with a custom role it also asks whether the caller holds every
 * capability, and every default level, the role would confer. An admin-based
 * custom role narrowed to member management passes `can()` for `member.update`
 * exactly as an admin would; measured by rank alone, it could invite a plain
 * admin, or promote a developer to one, and act through them.
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
  if (!roleWithinAuthority(actor, subjectRole)) {
    throw errors.forbidden('You cannot manage a role above your own.');
  }
}

/** One environment, as far as a grant's reach is concerned. */
export interface ReachedEnvironment {
  id: string;
  isProduction: boolean;
}

/**
 * Where an explicit grant would take effect: one environment, or a whole
 * project — together with every environment the project has now, because a
 * project-wide row is what each of them falls back to.
 */
export type GrantReach =
  | { projectId: string; environment: ReachedEnvironment }
  | {
      projectId: string;
      environment: null;
      projectEnvironments: readonly ReachedEnvironment[];
    };

/**
 * The most the caller may grant across `reach`: the lowest level they resolve
 * to anywhere the grant would land.
 *
 * Levels come from `resolveAccessLevel` over the caller's own membership — the
 * enforcement path — so a caller is measured by exactly what `can()` would let
 * them do there, custom-role ceiling and explicit grants included.
 *
 * ── A project-wide grant reaches further than it looks ──
 * It is the fall-back for every environment in the project that has no row of
 * its own, production included, and for every environment created later. So
 * the caller must hold the level on each environment the project has now, on
 * the project itself, *and* at the project's production level — the level they
 * would hold on a production environment added tomorrow, and the one
 * `project.delete` now asks for. Anything less lets a caller capped at `none`
 * on production write a project-wide `write` that lands on production.
 */
export function grantableAccessLevel(actor: Membership, reach: GrantReach): AccessLevel {
  return reachPoints(reach)
    .map((point) => levelAt(actor, reach.projectId, point))
    .reduce((lowest, level) => (compareAccessLevel(level, lowest) < 0 ? level : lowest));
}

/** One place a grant row takes effect: an environment, or the project itself. */
interface ReachPoint {
  environmentId: string | null;
  isProduction: boolean;
}

/**
 * Every place `reach` takes effect — the environment itself, or, for a whole
 * project, the project at both production levels and each of its environments.
 * See `grantableAccessLevel` for why the project appears twice.
 */
function reachPoints(reach: GrantReach): ReachPoint[] {
  if (reach.environment !== null) {
    return [{ environmentId: reach.environment.id, isProduction: reach.environment.isProduction }];
  }
  return [
    { environmentId: null, isProduction: false },
    { environmentId: null, isProduction: true },
    ...reach.projectEnvironments.map((environment) => ({
      environmentId: environment.id,
      isProduction: environment.isProduction,
    })),
  ];
}

function levelAt(membership: Membership, projectId: string, point: ReachPoint): AccessLevel {
  return resolveAccessLevel(
    { ...membership, isProduction: point.isProduction },
    projectId,
    point.environmentId,
  );
}

/**
 * Refuses an explicit grant above what the caller holds where it lands.
 *
 * The other half of "you can't hand out what you don't hold": a role is
 * measured by `assertRoleAuthority`, a grant by this. Before it, a grant's
 * level was limited by nothing but the target's role — so any member manager
 * could write production `admin` for anybody they could manage, whatever their
 * own access to production was.
 *
 * Universal, not only for callers holding a custom role. An owner or admin
 * with no restrictive grant of their own resolves to `admin` everywhere and
 * notices nothing. One who *has* been restricted — by a custom role's ceiling,
 * or by an explicit grant on themselves — can now hand out only what they
 * still hold, which is the point: a restriction that its holder can route
 * around by granting the access to a colleague, or to a second account, is not
 * a restriction.
 *
 * `none` always passes: taking access away confers nothing.
 */
export function assertGrantWithinAuthority(
  actor: StoredAuthorizationContext,
  level: AccessLevel,
  reach: GrantReach,
): void {
  if (compareAccessLevel(level, grantableAccessLevel(toGrantContext(actor), reach)) > 0) {
    throw errors.forbidden(GRANT_ABOVE_AUTHORITY);
  }
}

const GRANT_ABOVE_AUTHORITY = 'You cannot grant more access than you hold.';

/**
 * Refuses removing a grant when what the member falls back to would raise them
 * above what the caller holds.
 *
 * Removing a row is not only ever a narrowing. The member falls back to the
 * next rule down — a project-wide row, or their role's default — and that can
 * be *higher*: a developer's explicit `none` on production, removed, lets a
 * project-wide `write` take over there. Unchecked, a caller capped at `none` on
 * production could grant production by deletion exactly as the level check on
 * PUT stops them granting it by writing.
 *
 * So, at every place the removed row took effect (the same reach as PUT), the
 * member's level with the row gone is compared with their level now:
 *
 *  - not higher → fine. Removing a grant that lowers or keeps access confers
 *    nothing, whoever does it.
 *  - higher → the fallback must be within the caller's own level *at that same
 *    place*. Per place rather than the lowest across the reach, because the
 *    fallback differs per place: removing a developer's project-wide `read`
 *    raises staging to their role's `write` and leaves production at `none`,
 *    and a caller capped only on production holds everything that raise needs.
 *
 * `member` is the target's record and `memberGrants` their whole grant list —
 * both the enforcement path's inputs, so "what they fall back to" is what
 * `can()` would resolve for them the moment the row is gone.
 */
export function assertRemovalWithinAuthority(
  actor: StoredAuthorizationContext,
  member: Pick<MemberListEntry, 'role' | 'status' | 'customRole'>,
  memberGrants: readonly MemberGrant[],
  reach: GrantReach,
): void {
  const caller = toGrantContext(actor);
  const before: Membership = {
    role: member.role,
    memberStatus: member.status,
    ...(member.customRole === undefined ? {} : { customRole: member.customRole }),
    grants: memberGrants.map((grant) => ({
      projectId: grant.projectId,
      environmentId: grant.environmentId,
      accessLevel: grant.accessLevel,
    })),
  };
  const removedEnvironmentId = reach.environment?.id ?? null;
  const after: Membership = {
    ...before,
    grants: before.grants.filter(
      (grant) =>
        !(grant.projectId === reach.projectId && grant.environmentId === removedEnvironmentId),
    ),
  };

  for (const point of reachPoints(reach)) {
    const fallback = levelAt(after, reach.projectId, point);
    if (compareAccessLevel(fallback, levelAt(before, reach.projectId, point)) <= 0) continue;
    if (compareAccessLevel(fallback, levelAt(caller, reach.projectId, point)) > 0) {
      throw errors.forbidden(GRANT_ABOVE_AUTHORITY);
    }
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
  if (effectiveRole(actor.role, actor.customRole) !== 'owner') {
    throw errors.forbidden('You cannot change your own access grants.');
  }
}

/**
 * The reach of one resolved invitation seed, read off the organisation's
 * environment grid.
 *
 * An environment missing from the grid — deleted between the slug lookup and
 * here — is measured as production, the stricter of the two kinds; acceptance
 * would skip it anyway.
 */
export function invitationSeedReach(
  seed: InvitationGrantSeed,
  grid: readonly OrganizationEnvironment[],
): GrantReach {
  if (seed.environmentId === null) {
    return {
      projectId: seed.projectId,
      environment: null,
      projectEnvironments: grid.filter((environment) => environment.projectId === seed.projectId),
    };
  }
  const environment = grid.find((candidate) => candidate.id === seed.environmentId);
  return {
    projectId: seed.projectId,
    environment: { id: seed.environmentId, isProduction: environment?.isProduction ?? true },
  };
}

/**
 * Refuses an invitation whose initial grants exceed what the inviter holds.
 *
 * Each seed is measured at the level acceptance will actually write: the one
 * it names, or — for a seed that names none — the invited role's
 * *non-production* default, which acceptance writes even on a production
 * environment (see `applyInitialGrants`). Measuring an unstated level as "the
 * role default for this environment" would under-count exactly there.
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
      invitationSeedReach(seed, grid),
    );
  }
}

/**
 * Maps a `RepositoryError` from the membership layer onto the API vocabulary.
 * The messages are the repository's own — fixed literals, never derived from
 * the request — so passing them through leaks nothing.
 */
export function mapMembershipError(cause: unknown): never {
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
   * The level for project-scoped actions, which leave production out — all
   * but `project.delete`, which also needs the project's production level
   * (`includesProduction` in `ACTION_REQUIREMENTS`).
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
  member: Pick<MemberListEntry, 'role' | 'status' | 'customRole'>,
  grants: readonly MemberGrant[],
  environments: readonly OrganizationEnvironment[],
): EffectiveProjectAccess[] {
  const membership: Membership = {
    role: member.role,
    memberStatus: member.status,
    ...(member.customRole === undefined ? {} : { customRole: member.customRole }),
    grants: grants.map((grant) => ({
      projectId: grant.projectId,
      environmentId: grant.environmentId,
      accessLevel: grant.accessLevel,
    })),
  };

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
  member: Pick<MemberListEntry, 'status'>,
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
