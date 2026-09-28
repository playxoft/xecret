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

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
};

/**
 * Total ordering on roles: `viewer` < `developer` < `admin` < `owner`.
 *
 * Same convention as `compareAccessLevel`: negative when `a` is the lesser
 * role, zero when equal, positive when greater.
 */
export function compareOrgRole(a: OrgRole, b: OrgRole): number {
  return ORG_ROLE_RANK[a] - ORG_ROLE_RANK[b];
}

/**
 * Whether an actor may hand out — or take away — a given role.
 *
 * The rule is "no role above your own": an admin may invite or appoint another
 * admin, but only an owner may create an owner. Without this, `member.invite`
 * plus one forged request would let an admin mint an owner and then act through
 * them — a privilege escalation the capability table alone does not stop,
 * because the capability gate only asks *whether* a role may manage members,
 * not *which* members.
 *
 * The same predicate covers both sides of a change: assigning the new role and
 * touching a member who currently holds one. A route changing a member must
 * check it against the member's current role too, or an admin could "demote" an
 * owner — which is removing an owner's authority without holding it.
 *
 * This is the rank comparison alone, and rank is all a built-in role has. It is
 * not enough for an actor who may hold a custom role: an admin-based role
 * narrowed to member management still ranks as `admin`, and would pass this for
 * a plain `admin` it holds almost none of. Routes ask `roleWithinAuthority`,
 * which is this for a member without a custom role and strictly more for one
 * with.
 */
export function canAssignRole(actorRole: OrgRole, role: OrgRole): boolean {
  return compareOrgRole(actorRole, role) >= 0;
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
 *
 * `project.delete` is decided here at the project, with production left out
 * like every project-level question (see `can()`) — which on its own would be
 * too little, because deleting a project deletes every environment in it. So
 * the route deleting one also asks `environment.delete` of each environment the
 * project holds, and the level each of those resolves to decides: a member
 * whose custom role caps them at `none` on production, or whom an explicit
 * `none` keeps off one environment, cannot take that environment out through
 * the project door. It is asked per environment rather than folded into this
 * table because a project-wide level cannot see a restriction written against
 * a single environment.
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

/* ── Custom roles ──────────────────────────────────────────────────────────── */

/**
 * A role an organisation defined for itself.
 *
 * ── For the member holding it, a custom role can only SUBTRACT ──
 * Every custom role names a built-in `baseRole` and is resolved as
 * `base AND custom` — never `custom` alone. There is therefore no arrangement
 * of rows in the database, malformed or malicious, under which a custom role
 * gives the member who holds it a capability or a level their built-in role
 * does not already carry. That half is not guarded by validation that could be
 * bypassed; it is unreachable.
 *
 * It is the same shape as `limitOverrides` in the entitlements engine, for the
 * same reason: a mechanism with only one direction has no bugs in the other.
 *
 * ── What subtraction does not settle: what the holder can hand OUT ──
 * A narrowed member keeps whatever member management their list names, and
 * member management confers authority on *somebody else*. Measured by rank
 * alone, an admin-based role narrowed to `member.*` and capped at `none` on
 * production could invite a plain admin, promote a developer to one, or write
 * a production grant it cannot use itself — "only subtracts" true of the
 * holder and false of the organisation. So anything that hands authority out
 * is measured against what the actor actually holds rather than what they rank
 * as: `roleWithinAuthority` for roles, the functions in `authority.ts` for
 * grants, reinstatements, capability-widening role changes and service tokens,
 * and `canDefineCustomRole` for definitions. Those are checks, not structure —
 * the part a new route that confers authority has to remember.
 *
 * Because the ceiling and the action list are part of the role, both kinds of
 * check see them, and a custom role *contains* its holder: they cannot appoint
 * anybody, or write anything, past it. An explicit grant on a plain admin is
 * different — it restricts that admin's own access and bounds what they grant,
 * mint or unblock directly, but `roleWithinAuthority` measures roles by role,
 * so it does not stop them appointing another plain admin. Containing a member
 * manager is what a custom role is for.
 *
 * ── Two built-in roles are in play, and the LOWER one governs ──
 * A member holds a built-in `role` *and*, through the custom role, a
 * `baseRole`. Nothing in the engine forces the two to agree — an `admin` can be
 * assigned a custom role based on `viewer` — so every question a built-in role
 * answers is asked of `effectiveRole`, the lesser of the two: the capability
 * table, the access defaults, and the rank half of `roleWithinAuthority`.
 * Taking the member's `role` alone would let a custom role based on `viewer`
 * that lists `secret.update`, assigned to an admin, write secrets — the base
 * role's ceiling would be decorative. Taking `baseRole` alone would let a
 * viewer assigned a role based on `owner` become one. The minimum is the only
 * choice under which both fields can only ever narrow.
 *
 * No custom role is based on `owner`, and no owner holds one: the first is
 * refused by `canDefineCustomRole`, and the database refuses both. Nothing here
 * relies on that — such a row would resolve like any other pairing — but it
 * keeps "the owner" meaning one thing.
 *
 * ── Why `allowedActions` is a positive list and not a deny list ──
 * A deny list would mean any `Action` added to the union later is silently
 * granted to every custom role that predates it. Under a positive list a new
 * action is denied until an administrator opts in — the same fail-closed choice
 * `SERVICE_TOKEN_ACTIONS` makes, and for the same reason: a capability that
 * arrives without anyone deciding it should is exactly the kind nobody audits.
 * The one exception is `CUSTOM_ROLE_FLOOR`, the price of being a member at all.
 *
 * The cost is real and accepted: an organisation that adds a capability to the
 * product will not see it in its custom roles until somebody edits them. That
 * surfaces as "my custom role cannot do the new thing", which is a support
 * conversation. The alternative surfaces as a breach.
 */
export interface CustomRole {
  readonly id: string;
  readonly name: string;
  /**
   * The built-in role this narrows. Its capabilities are the ceiling — or the
   * member's own `role`'s are, whichever is lower (`effectiveRole`).
   */
  readonly baseRole: OrgRole;
  /**
   * Actions this role may perform, intersected with the effective role's.
   * `CUSTOM_ROLE_FLOOR` is kept whether or not it is listed.
   */
  readonly allowedActions: readonly Action[];
  /**
   * An optional ceiling on the level this role reaches, per environment kind —
   * everywhere, explicit grants and role defaults alike (`capAtCeiling` in
   * `grants.ts`). It never raises anything: a ceiling above a level leaves that
   * level alone.
   */
  readonly accessCeiling?: RoleAccessDefaults | undefined;
}

/** The part of a membership that says which role governs it. */
export interface RoleHolder {
  readonly role: OrgRole;
  readonly customRole?: CustomRole | undefined;
}

/**
 * Capabilities a custom role cannot take away — kept wherever the effective
 * role's own table grants them, whatever `allowedActions` says.
 *
 * `member.read` is how the rest of the product asks "is this an active member
 * of the organisation?". The `Action` union has no `org.read`, so the
 * organisation summary, the project listing, CLI device approval and the device
 * list, and a member's view of their own access all settle membership with it,
 * on the understanding that every active member holds it. A custom role that
 * omitted it — easily done, since the list is positive and `member.read` does
 * not look like what any role is *for* — would lock its holder out of the
 * organisation while leaving them every secret their list names, reachable
 * only through URLs the dashboard could no longer render.
 *
 * It stays inside the base: the floor is kept only where the effective role's
 * table already says `true`, so it adds nothing and "a custom role only
 * subtracts" holds unchanged. The cost is that no custom role can hide the
 * member list from its holder — which no built-in role does either, for the
 * reason `members/route.ts` gives. Keep this to what membership itself costs;
 * anything that lets a member *do* something belongs on the list, where
 * somebody decides it.
 */
export const CUSTOM_ROLE_FLOOR: readonly Action[] = ['member.read'];

/**
 * The built-in role that actually governs a member: the lower of their own
 * `role` and their custom role's `baseRole`.
 *
 * Every decision a built-in role makes for a member goes through this — the
 * capability table (`effectiveCapabilities`), the access defaults (the
 * fall-through in `resolveAccessLevel`), and the rank half of
 * `roleWithinAuthority`. See `CustomRole` for why the minimum, and not either
 * field alone, is what keeps "a custom role can only subtract" true for any row
 * in the database.
 *
 * Returns `role` itself when there is no custom role, so the common path is
 * the built-in one exactly.
 */
export function effectiveRole(role: OrgRole, custom: CustomRole | undefined): OrgRole {
  if (custom === undefined) return role;
  return compareOrgRole(custom.baseRole, role) < 0 ? custom.baseRole : role;
}

/**
 * The effective capability table for a member, custom role or not.
 *
 * `effectiveRole`'s table AND (the custom role's positive list OR
 * `CUSTOM_ROLE_FLOOR`). Returns the built-in table unchanged when there is no
 * custom role, so the common path allocates nothing and the two cases cannot
 * diverge.
 */
export function effectiveCapabilities(
  role: OrgRole,
  custom: CustomRole | undefined,
): Readonly<Record<Action, boolean>> {
  const base = ROLE_CAPABILITIES[effectiveRole(role, custom)];
  if (custom === undefined) return base;

  const allowed = new Set<Action>([...custom.allowedActions, ...CUSTOM_ROLE_FLOOR]);
  const result = {} as Record<Action, boolean>;

  // Iterating the base table rather than the custom list is what makes the
  // intersection total: every action gets an answer, and an action the custom
  // role names — or the floor names — that the base role lacks contributes
  // nothing.
  for (const action of Object.keys(base) as Action[]) {
    result[action] = base[action] && allowed.has(action);
  }

  return result;
}

/**
 * The level a member reaches where no grant says otherwise, per environment
 * kind: the weaker of `effectiveRole`'s defaults and the custom role's ceiling.
 *
 * Derived, not a step of resolution: `resolveAccessLevel` falls through to the
 * plain role default and lets `capAtCeiling` narrow it, which comes to the same
 * thing. It exists for questions asked about a role rather than a resource —
 * `roleWithinAuthority` measures what an actor can confer with it.
 */
export function narrowAccessDefaults(
  role: OrgRole,
  custom: CustomRole | undefined,
): RoleAccessDefaults {
  const base = ROLE_ACCESS_DEFAULTS[effectiveRole(role, custom)];
  if (custom?.accessCeiling === undefined) return base;

  const ceiling = custom.accessCeiling;
  return {
    nonProduction:
      compareAccessLevel(ceiling.nonProduction, base.nonProduction) < 0
        ? ceiling.nonProduction
        : base.nonProduction,
    production:
      compareAccessLevel(ceiling.production, base.production) < 0
        ? ceiling.production
        : base.production,
  };
}

/**
 * Whether an actor may hand out — or take away — `subjectRole`, measured by
 * everything the actor holds rather than by rank alone.
 *
 * True iff all three hold:
 *
 *  1. `canAssignRole(effectiveRole(actor), subjectRole)` — no role above your
 *     own, with your own being the lower of your two.
 *  2. Every capability `subjectRole` carries is one the actor holds
 *     (`effectiveCapabilities`).
 *  3. `subjectRole`'s access defaults are no higher than the actor's own, per
 *     environment kind (`narrowAccessDefaults`, ceiling included).
 *
 * (2) and (3) are what "you can't hand out what you don't hold" means for a
 * custom role. An admin-based role that lists only `member.*`, or is capped at
 * `none` on production, ranks as `admin` — and would otherwise invite, promote
 * or reinstate a plain admin, who holds on day one everything the actor's own
 * role was defined to withhold. Anybody the actor could appoint is somebody
 * they could then act through.
 *
 * For a member without a custom role this is exactly `canAssignRole`: the
 * built-in tables are nested — each role's capabilities and defaults contain
 * those of every role below it — so (2) and (3) follow from (1). The tests pin
 * that over every pair, so a table edit that broke the nesting would fail the
 * build rather than quietly change who plain admins may appoint.
 *
 * It measures roles, not grants: the actor's side is their role and custom
 * role, and explicit grants on the actor play no part. A plain admin whom an
 * owner held to `read` on production with a grant still passes this for
 * `admin`, and may appoint a plain admin — the grant restricts their own
 * access, not their management authority; a custom role's ceiling, which is
 * part of the role, is what (3) measures and what contains a member manager.
 * What an actor may write as an explicit grant, unblock by removing one, turn
 * back on by reinstating a member, or mint as a service token is measured
 * against their resolved level where it lands — `authority.ts`.
 */
export function roleWithinAuthority(actor: RoleHolder, subjectRole: OrgRole): boolean {
  if (!canAssignRole(effectiveRole(actor.role, actor.customRole), subjectRole)) return false;

  const held = effectiveCapabilities(actor.role, actor.customRole);
  const conferred = ROLE_CAPABILITIES[subjectRole];
  for (const action of Object.keys(conferred) as Action[]) {
    if (conferred[action] && !held[action]) return false;
  }

  const heldDefaults = narrowAccessDefaults(actor.role, actor.customRole);
  const conferredDefaults = ROLE_ACCESS_DEFAULTS[subjectRole];
  return (
    accessLevelAtLeast(heldDefaults.nonProduction, conferredDefaults.nonProduction) &&
    accessLevelAtLeast(heldDefaults.production, conferredDefaults.production)
  );
}

/**
 * Whether an actor may create a custom role with this base.
 *
 * Refused outright to three kinds of request:
 *
 *  - **An actor who holds a custom role.** A narrowed actor defining roles is a
 *    narrowed actor writing the rules they are narrowed by — and, at the limit,
 *    editing the very role they hold. Measuring the new role against theirs is
 *    possible, but "a restricted member cannot redefine restriction" is a rule
 *    nobody has to reason about, and the ones who need to define roles are the
 *    unrestricted admins and owners who assign them.
 *  - **A base of `owner`.** The owner is the role that cannot be removed while
 *    it is the last of its kind and the only one that can delete the
 *    organisation; a narrowed copy of it is a contradiction. The database
 *    refuses the row too.
 *  - **A base above the actor's own role** (`canAssignRole`). Without it an
 *    admin could define a role on a higher base and assign it — the escalation
 *    `canAssignRole` exists to close, routed around.
 *
 * ── What the part-2 routes must check on top of this ──
 * This answers for *creating* a definition, which on its own confers nothing.
 * The routes that make a definition reach people carry the rest:
 *
 *  - **Editing a role** must pass this for both the current and the new base,
 *    and `roleWithinAuthority(actor, holder.role)` for every member currently
 *    holding it — widening a role's list or ceiling raises each holder, and an
 *    actor may not raise somebody they could not otherwise manage.
 *  - **Assigning or unassigning one** must pass `roleWithinAuthority` over the
 *    member's stored `role`. Assignment only narrows, but unassignment returns
 *    a member to the whole of that role, and so does swapping one custom role
 *    for a wider one.
 *  - **Any of these that gains the member capabilities** (`capabilitiesGained`
 *    in `authority.ts`) turns on grant rows the member already holds, and must
 *    pass `heldGrantsWithinAuthority` over them — as the member route does for
 *    a built-in role change.
 */
export function canDefineCustomRole(actor: RoleHolder, baseRole: OrgRole): boolean {
  if (actor.customRole !== undefined) return false;
  if (baseRole === 'owner') return false;
  return canAssignRole(actor.role, baseRole);
}

/**
 * The built-in roles a custom role may be based on — every role but `owner`,
 * highest first.
 *
 * `owner` is left out for the reason `canDefineCustomRole` gives, and the
 * database refuses it too (`custom_roles_base_role_check`). Listed here so the
 * API's schema and the dashboard's base-role menu offer the same three, from
 * one definition, rather than each filtering `owner` out on its own.
 */
export const CUSTOM_ROLE_BASE_ROLES: readonly Exclude<OrgRole, 'owner'>[] = [
  'admin',
  'developer',
  'viewer',
];

/**
 * The actions a custom role based on `baseRole` could usefully list: those the
 * base role's own table grants, in table order.
 *
 * Anything else on the list would be dead weight — `effectiveCapabilities`
 * intersects it with the base, so an action the base lacks confers nothing —
 * and dead weight in a permission list is worse than noise: it reads as a
 * grant to whoever reviews the role later. So the API refuses a definition
 * naming one (`actionsBeyondBase`), and the dashboard offers only these.
 */
export function actionsForBase(baseRole: OrgRole): Action[] {
  const table = ROLE_CAPABILITIES[baseRole];
  return (Object.keys(table) as Action[]).filter((action) => table[action]);
}

/**
 * The actions in `actions` that a role based on `baseRole` could never
 * perform — empty for a list the base covers.
 *
 * Returned rather than answered as a boolean so a refusal can say which, and
 * de-duplicated in table order so the answer does not depend on how the
 * request happened to order them.
 */
export function actionsBeyondBase(baseRole: OrgRole, actions: readonly Action[]): Action[] {
  const table = ROLE_CAPABILITIES[baseRole];
  const listed = new Set(actions);
  return (Object.keys(table) as Action[]).filter((action) => listed.has(action) && !table[action]);
}
