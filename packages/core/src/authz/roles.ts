import type { AccessLevel, Action, OrgRole } from './types';

/**
 * What each role may do, and how much access it carries where nothing says
 * otherwise.
 *
 * Two independent gates decide every request, and both must pass:
 *
 *   1. **Capability** — is this class of action available to this role at all?
 *      Org-wide and resource-independent (`ROLE_CAPABILITIES`).
 *   2. **Access level** — does the actor hold a high enough level on *this*
 *      project or environment? Resolved per resource in `grants.ts`
 *      (`ACTION_REQUIREMENTS`).
 *
 * Keeping the two separate is what makes a grant safe to hand out. Raising
 * someone to `admin` on one environment cannot turn a `viewer` into a writer,
 * because the viewer's capability row says `secret.update: false` and no grant
 * can edit that row. Equally, an `admin` capability is worth nothing on an
 * environment where the resolved level is `none`.
 *
 * See docs/architecture/database-schema.md §6.
 */

const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Total ordering on access levels: `none` < `read` < `write` < `admin`.
 *
 * Negative when `a` is weaker than `b`, zero when equal, positive when
 * stronger — the `Array.prototype.sort` convention, so the UI can sort grants
 * with it.
 */
export function compareAccessLevel(a: AccessLevel, b: AccessLevel): number {
  return ACCESS_LEVEL_RANK[a] - ACCESS_LEVEL_RANK[b];
}

/** True when `held` is at least as permissive as `required`. */
export function accessLevelAtLeast(held: AccessLevel, required: AccessLevel): boolean {
  return compareAccessLevel(held, required) >= 0;
}

export interface RoleAccessDefaults {
  nonProduction: AccessLevel;
  production: AccessLevel;
}

/**
 * The level a role carries on a resource no grant mentions.
 *
 * Production is deny-by-default for everyone below `admin`, developers
 * included. A developer who needs production must be granted it explicitly,
 * which is a deliberate act by someone who holds `member.update`, and which
 * lands in the audit log with a name attached. The alternative — production
 * behaving like every other environment until someone remembers to lock it
 * down — makes the safe state the one that requires work.
 *
 * `viewer` gets `none` on production for the same reason. Giving a viewer
 * `read` there would leave a viewer with strictly more production access than a
 * developer, which no reviewer would be able to justify.
 */
export const ROLE_ACCESS_DEFAULTS: Record<OrgRole, RoleAccessDefaults> = {
  owner: { nonProduction: 'admin', production: 'admin' },
  admin: { nonProduction: 'admin', production: 'admin' },
  developer: { nonProduction: 'write', production: 'none' },
  viewer: { nonProduction: 'read', production: 'none' },
};

/** The role's level for an environment, before any grant is considered. */
export function roleDefaultAccessLevel(role: OrgRole, isProduction: boolean): AccessLevel {
  const defaults = ROLE_ACCESS_DEFAULTS[role];
  return isProduction ? defaults.production : defaults.nonProduction;
}

/**
 * Every action, for every role.
 *
 * Deliberately `Record<OrgRole, Record<Action, boolean>>` rather than a set of
 * permitted actions per role: adding a member to the `Action` union breaks the
 * build until all four roles have stated a position on it. A set would compile
 * and silently deny the new action to everyone — a safe outcome, but an
 * invisible one that surfaces as a bug report from an owner who cannot use a
 * feature, weeks after the pull request that should have decided it. The type
 * system puts that decision in the diff that introduces the action.
 *
 * `false` here is stronger than a low access level: no grant can override it.
 */
export const ROLE_CAPABILITIES: Record<OrgRole, Record<Action, boolean>> = {
  owner: {
    'project.read': true,
    'project.create': true,
    'project.update': true,
    'project.delete': true,
    'environment.read': true,
    'environment.create': true,
    'environment.update': true,
    'environment.delete': true,
    'secret.read': true,
    'secret.create': true,
    'secret.update': true,
    'secret.delete': true,
    'secret.rotate': true,
    'member.read': true,
    'member.invite': true,
    'member.update': true,
    'member.remove': true,
    'audit.read': true,
    'token.create': true,
    'token.revoke': true,
    'org.update': true,
    'org.delete': true,
  },
  // Identical to `owner` but for `org.delete`. Deleting the organisation
  // destroys every key and every secret in it, so it stays with the role that
  // cannot be removed while it is the last of its kind.
  admin: {
    'project.read': true,
    'project.create': true,
    'project.update': true,
    'project.delete': true,
    'environment.read': true,
    'environment.create': true,
    'environment.update': true,
    'environment.delete': true,
    'secret.read': true,
    'secret.create': true,
    'secret.update': true,
    'secret.delete': true,
    'secret.rotate': true,
    'member.read': true,
    'member.invite': true,
    'member.update': true,
    'member.remove': true,
    'audit.read': true,
    'token.create': true,
    'token.revoke': true,
    'org.update': true,
    'org.delete': false,
  },
  // A developer's authority is enumerated rather than expressed as "admin minus
  // a few things", so a new action defaults to denied for them.
  //
  // `project.delete` and `environment.delete` are denied at the capability gate,
  // where no grant can reach them: deleting an environment discards its data
  // key, and every secret it held becomes unrecoverable even from a backup. That
  // is not an operation to reach by accumulating grants.
  //
  // `token.create` is likewise administrative. A service token is a long-lived
  // credential that sits in a CI provider and outlives the employment of
  // whoever minted it (threat T5); issuing one is a decision for someone who
  // can also revoke it.
  //
  // `audit.read` is denied because the audit log is an org-wide record of who
  // did what, including actions in projects the developer has no access to.
  developer: {
    'project.read': true,
    'project.create': true,
    'project.update': true,
    'project.delete': false,
    'environment.read': true,
    'environment.create': true,
    'environment.update': true,
    'environment.delete': false,
    'secret.read': true,
    'secret.create': true,
    'secret.update': true,
    'secret.delete': true,
    'secret.rotate': true,
    'member.read': true,
    'member.invite': false,
    'member.update': false,
    'member.remove': false,
    'audit.read': false,
    'token.create': false,
    'token.revoke': false,
    'org.update': false,
    'org.delete': false,
  },
  // Every mutation is `false`, not merely gated on access level. Granting a
  // viewer `admin` on one environment is an easy slip in the grants UI; it
  // raises what they can see, never what they can change.
  viewer: {
    'project.read': true,
    'project.create': false,
    'project.update': false,
    'project.delete': false,
    'environment.read': true,
    'environment.create': false,
    'environment.update': false,
    'environment.delete': false,
    'secret.read': true,
    'secret.create': false,
    'secret.update': false,
    'secret.delete': false,
    'secret.rotate': false,
    'member.read': true,
    'member.invite': false,
    'member.update': false,
    'member.remove': false,
    'audit.read': false,
    'token.create': false,
    'token.revoke': false,
    'org.update': false,
    'org.delete': false,
  },
};

/**
 * Levels that can satisfy a requirement.
 *
 * `none` is excluded by construction: it is a denial, so "requires `none`" is
 * not a thing anyone can accidentally write.
 */
export type RequiredAccessLevel = Exclude<AccessLevel, 'none'>;

/**
 * Where an action is evaluated, and the level it needs there.
 *
 * `org` actions are settled by the capability gate alone — no grant confers
 * them, and no grant can take them away. `project` and `environment` actions
 * additionally resolve a level against the resource named in the request.
 */
export type ActionRequirement =
  | { scope: 'org' }
  | { scope: 'project'; minimum: RequiredAccessLevel }
  | { scope: 'environment'; minimum: RequiredAccessLevel };

/**
 * The second gate: the minimum level each action needs on the resource it
 * names. Exhaustive over `Action` for the same reason `ROLE_CAPABILITIES` is.
 *
 * `project.create` is org-scoped because the project it would create does not
 * exist yet, so there is nothing to resolve a level against.
 *
 * `environment.create` is project-scoped and needs `write`: adding an
 * environment puts no existing data at risk, since its data key is new and
 * empty. `environment.update` needs `admin` even though it looks like the
 * gentler operation, because it can flip `is_production` — and that flag is
 * what makes production deny-by-default for everybody else.
 */
export const ACTION_REQUIREMENTS: Record<Action, ActionRequirement> = {
  'project.read': { scope: 'project', minimum: 'read' },
  'project.create': { scope: 'org' },
  'project.update': { scope: 'project', minimum: 'admin' },
  'project.delete': { scope: 'project', minimum: 'admin' },
  'environment.read': { scope: 'environment', minimum: 'read' },
  'environment.create': { scope: 'project', minimum: 'write' },
  'environment.update': { scope: 'environment', minimum: 'admin' },
  'environment.delete': { scope: 'environment', minimum: 'admin' },
  'secret.read': { scope: 'environment', minimum: 'read' },
  'secret.create': { scope: 'environment', minimum: 'write' },
  'secret.update': { scope: 'environment', minimum: 'write' },
  'secret.delete': { scope: 'environment', minimum: 'write' },
  'secret.rotate': { scope: 'environment', minimum: 'write' },
  'member.read': { scope: 'org' },
  'member.invite': { scope: 'org' },
  'member.update': { scope: 'org' },
  'member.remove': { scope: 'org' },
  'audit.read': { scope: 'org' },
  'token.create': { scope: 'org' },
  'token.revoke': { scope: 'org' },
  'org.update': { scope: 'org' },
  'org.delete': { scope: 'org' },
};
