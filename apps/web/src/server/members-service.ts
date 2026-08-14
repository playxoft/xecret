import type { AccessLevel, OrgRole } from '@xecret/core/authz';
import { canAssignRole, resolveAccessLevel } from '@xecret/core/authz';
import { RepositoryError } from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  MemberGrant,
  MemberListEntry,
  OrganizationEnvironment,
} from '@xecret/db/repositories';
import type { Principal } from './actor';
import { errors } from './errors';
import type { OrgScope } from './tenancy';

/**
 * Member management — the pieces the member and invitation routes share.
 *
 * Three concerns live here rather than in the routes:
 *
 *  1. **The role hierarchy.** `can()` answers whether a role may manage members
 *     at all; it does not compare the two roles involved. Without the second
 *     check, an admin could mint an owner and act through them. The predicate
 *     is `canAssignRole` from `@xecret/core/authz`; this module is where it is
 *     applied to both sides of every change — the role being handed out *and*
 *     the role currently held by the member being touched.
 *
 *  2. **The session requirement.** Inviting someone mints a credential (the
 *     invitation token), and the standing rule from the CLI authorization flow
 *     applies: a bearer credential may not mint further credentials. Member
 *     mutations therefore require the browser session, where CSRF and the PIN
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
 * Refuses a change that touches a role above the caller's own.
 *
 * Applied to the target's *current* role when managing an existing member, and
 * to the *new* role when assigning one. The message does not name either role:
 * it is a fixed string, and the caller already knows what they asked for.
 */
export function assertRoleAuthority(actorRole: OrgRole, subjectRole: OrgRole): void {
  if (!canAssignRole(actorRole, subjectRole)) {
    throw errors.forbidden('You cannot manage a role above your own.');
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
  /** The level for project-scoped actions, which ignore production status. */
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
 */
export function effectiveAccess(
  member: Pick<MemberListEntry, 'role' | 'status'>,
  grants: readonly MemberGrant[],
  environments: readonly OrganizationEnvironment[],
): EffectiveProjectAccess[] {
  const membership = {
    role: member.role,
    memberStatus: member.status,
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
