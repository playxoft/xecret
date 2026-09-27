import { SERVICE_TOKEN_ACTIONS } from './can';
import { resolveAccessLevel } from './grants';
import type { Membership, ResolvedGrant } from './grants';
import { accessLevelAtLeast, compareAccessLevel, effectiveCapabilities } from './roles';
import type { RoleHolder } from './roles';
import type { AccessLevel, Action, OrgRole } from './types';

/**
 * Authority: what a member may confer on somebody else.
 *
 * `can()` answers "may this member do this, here?". It does not compare the
 * member with what they are *handing out* — `member.update` says a member may
 * write grants, not which ones, and `token.create` says they may mint tokens,
 * not with what reach. Those questions are asked here, as pure functions over
 * the same `Membership` `can()` reads, and they share one measure: **a member
 * may confer a level only where they resolve to at least that level
 * themselves** — `resolveAccessLevel`, the enforcement path, so custom-role
 * ceilings and explicit grants on the actor count exactly as they do at
 * request time.
 *
 * Roles are measured by `roleWithinAuthority` in `roles.ts`. Everything that
 * confers a *level* is measured here:
 *
 *  - writing a grant (`grantWithinAuthority`), directly or as an invitation's
 *    initial grants;
 *  - removing one, which can raise a member to whatever the row overrode
 *    (`removalWithinAuthority`);
 *  - turning a member's existing grants back on — reinstatement — or turning
 *    on what they permit — a role change that adds capabilities
 *    (`heldGrantsWithinAuthority`, `capabilitiesGained`);
 *  - minting a service token (`serviceTokenActionsAt`, each action then asked
 *    of `can()` on the pinned environment).
 *
 * ── What this bounds, and what it does not ──
 * For a member holding a custom role, the role's ceiling and action list are
 * measured on both sides: here for levels, by `roleWithinAuthority` for roles.
 * That is containment — the member cannot hand anybody, themselves included,
 * more than the role leaves them.
 *
 * For a plain owner or admin held down by an explicit grant on themselves, it
 * is narrower than that, on purpose. The grant restricts their own access and
 * bounds what they grant, mint or unblock *directly*; it does not contain their
 * management authority. `roleWithinAuthority` measures roles by role, so such
 * an admin can still invite or promote another plain admin, who holds on day
 * one what the grant withheld. Containing a member manager is what a custom
 * role is for — its ceiling is part of the role, and `roleWithinAuthority`
 * does measure that.
 *
 * Owners and admins with nothing written against them resolve to `admin`
 * everywhere, so none of these checks ever refuses them.
 */

/* ── Where a grant row takes effect ─────────────────────────────────────── */

/** One environment, as far as a grant's reach is concerned. */
export interface ReachedEnvironment {
  readonly id: string;
  readonly isProduction: boolean;
}

/** One environment of the organisation's grid, with the project it belongs to. */
export interface GridEnvironment extends ReachedEnvironment {
  readonly projectId: string;
}

/**
 * Where an explicit grant row takes effect: one environment, or a whole
 * project — together with every environment the project has now, because a
 * project-wide row is what each of them falls back to.
 */
export type GrantReach =
  | { readonly projectId: string; readonly environment: ReachedEnvironment }
  | {
      readonly projectId: string;
      readonly environment: null;
      readonly projectEnvironments: readonly ReachedEnvironment[];
    };

/** One place a grant row takes effect: an environment, or the project itself. */
export interface ReachPoint {
  readonly environmentId: string | null;
  readonly isProduction: boolean;
}

/**
 * Every place `reach` takes effect.
 *
 * For one environment, that environment. For a whole project, the project at
 * both production levels and each environment it has now. The project appears
 * twice because a project-wide row is also the fall-back for every environment
 * created *later*, production included — so its production level is where the
 * row would land on a production environment added tomorrow.
 */
export function reachPoints(reach: GrantReach): ReachPoint[] {
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

/**
 * The reach of a grant row naming `projectId` and `environmentId`, read off
 * the organisation's environment grid.
 *
 * An environment missing from the grid — soft-deleted, or deleted between a
 * lookup and here — is measured as production, the stricter of the two kinds.
 * A soft-deleted environment can be restored, and a grant on it comes back
 * with it.
 */
export function grantReach(
  projectId: string,
  environmentId: string | null,
  grid: readonly GridEnvironment[],
): GrantReach {
  if (environmentId === null) {
    return {
      projectId,
      environment: null,
      projectEnvironments: grid.filter((environment) => environment.projectId === projectId),
    };
  }
  const environment = grid.find((candidate) => candidate.id === environmentId);
  return {
    projectId,
    environment: { id: environmentId, isProduction: environment?.isProduction ?? true },
  };
}

function levelAt(membership: Membership, projectId: string, point: ReachPoint): AccessLevel {
  return resolveAccessLevel(
    { ...membership, isProduction: point.isProduction },
    projectId,
    point.environmentId,
  );
}

/* ── Writing a grant ────────────────────────────────────────────────────── */

/**
 * The most `actor` may grant across `reach`: the lowest level they resolve to
 * anywhere the grant would land (`reachPoints`).
 *
 * Anything less than the lowest lets a grant reach somewhere its author could
 * not: a caller capped at `none` on production writing a project-wide `write`
 * that lands on production.
 */
export function grantableAccessLevel(actor: Membership, reach: GrantReach): AccessLevel {
  return reachPoints(reach)
    .map((point) => levelAt(actor, reach.projectId, point))
    .reduce((lowest, level) => (compareAccessLevel(level, lowest) < 0 ? level : lowest));
}

/**
 * Whether `actor` may write a grant of `level` across `reach`.
 *
 * `none` always passes: taking access away confers nothing.
 */
export function grantWithinAuthority(
  actor: Membership,
  level: AccessLevel,
  reach: GrantReach,
): boolean {
  return accessLevelAtLeast(grantableAccessLevel(actor, reach), level);
}

/* ── Removing a grant ───────────────────────────────────────────────────── */

/**
 * Whether `actor` may remove `member`'s grant row at `reach`.
 *
 * Removing a row is not only ever a narrowing. The member falls back to the
 * next rule down — a project-wide row, or their role's default — and that can
 * be *higher*: a developer's explicit `none` on production, removed, lets a
 * project-wide `write` take over there.
 *
 * So, at every place the row took effect, the member's level with the row gone
 * is compared with their level now:
 *
 *  - not higher → fine. A removal that lowers or keeps access confers nothing.
 *  - higher → the fallback must be within `actor`'s own level *at that same
 *    place*. Per place rather than the lowest across the reach, because the
 *    fallback differs per place: removing a developer's project-wide `read`
 *    raises staging to their role's `write` and leaves production at `none`,
 *    and an actor capped only on production holds everything that raise needs.
 *
 * ── Measured as active, whatever the member's status ──
 * A suspended member resolves to `none` everywhere, so measured as they stand
 * nothing would ever look raised. But the row removed now is still gone when
 * they are reinstated — suspend, remove the restriction, reinstate would lift
 * it past anybody's authority. The member is measured as the active member the
 * removal will eventually apply to.
 */
export function removalWithinAuthority(
  actor: Membership,
  member: Membership,
  reach: GrantReach,
): boolean {
  const before: Membership = { ...member, memberStatus: 'active' };
  const removedEnvironmentId = reach.environment?.id ?? null;
  const after: Membership = {
    ...before,
    grants: before.grants.filter(
      (grant) =>
        !(grant.projectId === reach.projectId && grant.environmentId === removedEnvironmentId),
    ),
  };

  return reachPoints(reach).every((point) => {
    const fallback = levelAt(after, reach.projectId, point);
    if (compareAccessLevel(fallback, levelAt(before, reach.projectId, point)) <= 0) return true;
    return accessLevelAtLeast(levelAt(actor, reach.projectId, point), fallback);
  });
}

/* ── Turning existing grants on ─────────────────────────────────────────── */

/**
 * Whether every grant row `grants` holds is one `actor` could have written.
 *
 * Asked where a member's existing rows are about to *take effect* without
 * anybody writing them: a reinstatement — every row of a suspended member is
 * dormant until then — and a role change that adds capabilities, which turns a
 * row the old role could only read through into one the new role writes
 * through (`capabilitiesGained`). Either would otherwise hand the member access
 * an owner wrote, through somebody who does not hold it.
 *
 * Each row is measured exactly as writing it would be (`grantWithinAuthority`,
 * at the level stored and across its whole reach), so `none` rows pass. That
 * is stricter than measuring what the row resolves to for this member — a row
 * a custom role's ceiling caps is measured as written — which errs in the safe
 * direction: the change stays available to anybody who could have written the
 * rows.
 */
export function heldGrantsWithinAuthority(
  actor: Membership,
  grants: readonly ResolvedGrant[],
  grid: readonly GridEnvironment[],
): boolean {
  return grants.every((grant) =>
    grantWithinAuthority(
      actor,
      grant.accessLevel,
      grantReach(grant.projectId, grant.environmentId, grid),
    ),
  );
}

/**
 * What a member holds after their role becomes `role`.
 *
 * The same custom role — a role change does not touch it — except that a
 * promotion to owner drops it: no owner holds one, and the repository clears
 * it in the same write.
 */
export function afterRoleChange(member: RoleHolder, role: OrgRole): RoleHolder {
  return role === 'owner' || member.customRole === undefined
    ? { role }
    : { role, customRole: member.customRole };
}

/**
 * Actions `to` may perform that `from` may not, each through its own custom
 * role (`effectiveCapabilities`).
 *
 * Non-empty exactly when a role change makes the member's existing grants
 * reach further than they did: a viewer's production `write` row lets them
 * read production, and the same row lets a developer write it.
 */
export function capabilitiesGained(from: RoleHolder, to: RoleHolder): Action[] {
  const before = effectiveCapabilities(from.role, from.customRole);
  const after = effectiveCapabilities(to.role, to.customRole);
  return (Object.keys(after) as Action[]).filter((action) => after[action] && !before[action]);
}

/* ── Minting a service token ────────────────────────────────────────────── */

/**
 * Every action a service token issued at `level` can perform — the entries of
 * `SERVICE_TOKEN_ACTIONS` that level satisfies.
 *
 * A minter must pass `can()` for each of these on the pinned environment:
 * `secret.read` for a `read` token, and `secret.create` and `secret.update`
 * besides for a `write` one. That is the capability and the level in one
 * question, so a minter capped at `none` on production cannot mint there, and
 * one whose custom role omits `secret.update` cannot mint a token that writes.
 */
export function serviceTokenActionsAt(level: AccessLevel): Action[] {
  return (Object.keys(SERVICE_TOKEN_ACTIONS) as Action[]).filter((action) => {
    const minimum = SERVICE_TOKEN_ACTIONS[action];
    return minimum !== undefined && accessLevelAtLeast(level, minimum);
  });
}
