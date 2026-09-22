import { compareAccessLevel, narrowAccessDefaults, roleDefaultAccessLevel } from './roles';
import type { CustomRole } from './roles';
import type { AccessLevel, OrgRole } from './types';

/**
 * Resolving one effective access level out of a member's grant rows.
 *
 * ## Precedence — most specific wins
 *
 *     1. a grant for (member, project, environment)   ← most specific
 *     2. a grant for (member, project, NULL)          ← the whole project
 *     3. the role default, production-aware
 *
 * The search stops at the first level that has anything to say. Specificity
 * beats permissiveness in *both* directions: an environment grant of `read`
 * overrides a project-wide `admin`, and an environment grant of `admin`
 * overrides a project-wide `read`. A "highest level wins" rule would read more
 * naturally and would be wrong — it makes it impossible to express "this member
 * has the run of the project except for production", which is the single most
 * common thing an operator wants to say.
 *
 * ## An explicit `none` is a denial
 *
 * `none` is a stored value, not the absence of a row, and it denies even for
 * `owner` and `admin`. An operator who revokes their own access to production —
 * a real practice, so that a routine mistake cannot reach it — must stay
 * revoked; the role default is what applies when nobody has expressed an
 * intention, and here somebody has. Treating `none` as "no opinion" would
 * silently discard an instruction that was typed deliberately.
 *
 * Every function here is pure and takes only what the database supplies, so the
 * rules can be tested without one.
 *
 * See docs/architecture/database-schema.md §6.
 */

export type MemberStatus = 'active' | 'suspended';

/** One `access_grants` row, already narrowed to the acting member. */
export interface ResolvedGrant {
  projectId: string;
  /** `null` when the grant covers the whole project, mirroring the nullable column. */
  environmentId: string | null;
  accessLevel: AccessLevel;
}

/** The acting member as authorization sees them. */
export interface Membership {
  role: OrgRole;
  memberStatus: MemberStatus;
  /**
   * A role the organisation defined, narrowing `role`.
   *
   * Never replaces `role`: the built-in role remains the ceiling and the thing
   * `canAssignRole` compares. See `CustomRole` in `roles.ts` for why a custom
   * role can only subtract, and why that makes escalation through this field
   * unreachable rather than merely guarded against.
   */
  customRole?: CustomRole | undefined;
  /**
   * The acting member's own rows and nothing else. A query that forgets to
   * filter by `org_member_id` would hand one member another member's authority,
   * so the caller owns that filter and this module assumes it.
   */
  grants: readonly ResolvedGrant[];
}

export interface GrantContext extends Membership {
  /** Whether the environment being resolved is flagged production. */
  isProduction: boolean;
}

/**
 * The member's effective level on a project, or on one environment within it.
 *
 * Pass `null` for `environmentId` to ask about the project as a whole; an
 * environment-specific grant then does not participate, since a grant on one
 * environment says nothing about the project that contains it.
 *
 * Grants belonging to another project are ignored: the project id is part of
 * every match, so a member with `admin` on project A resolves to their role
 * default on project B (threat T2).
 */
export function resolveAccessLevel(
  context: GrantContext,
  projectId: string,
  environmentId: string | null,
): AccessLevel {
  // Repeated in `can()`, and deliberately not left to it: this function is
  // exported and pure, and a future caller must not be able to obtain a level
  // for a suspended member by reaching past the one place that remembered to
  // check. Suspension is a revocation of everything, so it outranks even an
  // explicit grant.
  if (context.memberStatus === 'suspended') return 'none';

  return capAtCustomRole(context, resolveFromGrants(context, projectId, environmentId));
}

function resolveFromGrants(
  context: GrantContext,
  projectId: string,
  environmentId: string | null,
): AccessLevel {
  if (environmentId !== null) {
    // `find` rather than a fold over every match: `access_grants_unique_idx`
    // permits at most one row per (member, project, environment).
    const forEnvironment = context.grants.find(
      (grant) => grant.projectId === projectId && grant.environmentId === environmentId,
    );
    if (forEnvironment !== undefined) return forEnvironment.accessLevel;
  }

  const forProject = context.grants.find(
    (grant) => grant.projectId === projectId && grant.environmentId === null,
  );
  if (forProject !== undefined) return forProject.accessLevel;

  return roleDefaultAccessLevel(context.role, context.isProduction);
}

/**
 * Applies a custom role's ceiling to the level the grants produced.
 *
 * ── Why this caps an explicit grant and not only the role default ──
 * A ceiling that a grant can exceed is not a ceiling. The whole reason an
 * organisation defines "a developer who can never reach production" is to have
 * a statement that stays true, and it would not stay true the first time
 * somebody wrote a production grant for that member — which is an ordinary act
 * by an ordinary admin, not an attack, and precisely the mistake the role was
 * created to make impossible.
 *
 * The cost is that a grant can now be silently weaker than what was written.
 * That is the right direction to be surprised in, and the effective-permission
 * preview shows the resolved level rather than the stored one, so "what can
 * Alice actually see?" still answers honestly.
 */
function capAtCustomRole(context: GrantContext, level: AccessLevel): AccessLevel {
  if (context.customRole?.accessCeiling === undefined) return level;

  const ceiling = narrowAccessDefaults(context.role, context.customRole);
  const limit = context.isProduction ? ceiling.production : ceiling.nonProduction;

  return compareAccessLevel(level, limit) > 0 ? limit : level;
}
