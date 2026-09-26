import { assertCan, AuthorizationError } from '@xecret/core/authz';
import type {
  AccessLevel,
  Action,
  Actor,
  Denial,
  Membership,
  Resource,
  ResolvedGrant,
} from '@xecret/core/authz';
import type { Entitlements } from '@xecret/core/entitlements';
import {
  entitlementsFromRow,
  findEnvironmentBySlug,
  findOrganizationBySlugWithEntitlements,
  findProjectBySlug,
  loadAuthorizationContext,
} from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  EnvironmentRecord,
  Organization,
  ProjectRecord,
} from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';

/**
 * Resolving a request path into an authorized scope.
 *
 * This is the step between "who is this?" (`actor.ts`) and "may they?"
 * (`can()` in `@xecret/core/authz`). It exists as one module, with one way in
 * per level, because it is where cross-tenant isolation is actually enforced —
 * and a control that is reimplemented per route is a control that will
 * eventually be forgotten in one of them (threat T2, the most likely real
 * breach).
 *
 * Every resolver below returns `not_found` for anything the caller may not see:
 * a slug in another organisation, a project they hold no grant on, an
 * environment outside a service token's pin. They are indistinguishable from a
 * genuinely absent resource on purpose. Answering `forbidden` would confirm the
 * resource exists, which is a directory of another tenant's projects.
 */

export interface OrgScope {
  organization: Organization;
  actor: Actor;
  /** Absent for a service token, which has no membership to resolve. */
  membership: StoredAuthorizationContext | undefined;
  /**
   * The third gate, resolved from the same row that found the organisation.
   *
   * Present for every principal including a service token, because a limit
   * belongs to the organisation rather than to whoever is asking. It costs no
   * extra query: `findOrganizationBySlugWithEntitlements` carries the columns
   * along on the lookup `resolveOrg` was already making.
   *
   * Holding it here — rather than fetching it where it is checked — is what
   * keeps "no extra query on the hot path" a structural property instead of a
   * thing each route has to remember.
   */
  entitlements: Entitlements;
}

export interface ProjectScope extends OrgScope {
  project: ProjectRecord;
}

export interface EnvironmentScope extends ProjectScope {
  environment: EnvironmentRecord;
}

/**
 * Resolves an organisation slug for the current principal.
 *
 * Note the order: the organisation is looked up first, then membership, and a
 * miss at *either* step produces the same `not_found`. Checking membership first
 * and reporting "no such organisation" separately would let an attacker
 * enumerate which slugs are taken.
 */
export async function resolveOrg(
  principal: Principal,
  slug: string,
  services: ServiceContext,
): Promise<OrgScope> {
  const found = await findOrganizationBySlugWithEntitlements(services.db, slug);
  if (!found) throw errors.notFound(`no organisation with slug`);

  const { organization } = found;
  const entitlements = entitlementsFromRow(found.entitlements);

  if (principal.kind === 'serviceToken') {
    // A service token carries its organisation; it does not get to name one.
    // Any other slug is refused before a membership lookup that would find
    // nothing anyway — the token has no member row by construction.
    if (principal.orgId !== organization.id) throw errors.notFound('service token org mismatch');

    bindScope(services, { orgId: organization.id, orgSlug: organization.slug });

    return {
      organization,
      actor: {
        kind: 'serviceToken',
        tokenId: principal.tokenId,
        orgId: principal.orgId,
        projectId: principal.projectId,
        environmentId: principal.environmentId,
      },
      membership: undefined,
      entitlements,
    };
  }

  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;

  const membership = await loadAuthorizationContext(services.db, {
    orgId: organization.id,
    userId,
  });
  if (!membership) throw errors.notFound('no membership in organisation');

  bindScope(services, { orgId: organization.id, orgSlug: organization.slug });

  return {
    organization,
    actor:
      principal.kind === 'user'
        ? { kind: 'user', userId, orgId: organization.id }
        : { kind: 'cliToken', tokenId: principal.tokenId, userId, orgId: organization.id },
    membership,
    entitlements,
  };
}

/**
 * Stamps the tenancy onto every subsequent log line of this request.
 *
 * Done here rather than at each call site because this is the choke point: a
 * route cannot reach a project, an environment or a secret without coming
 * through these resolvers first, so binding here makes "which workspace was
 * this?" answerable for every tenant-scoped line in the system without any
 * route remembering to say so.
 *
 * Deliberately *after* the not-found throws above. A failed resolution has not
 * established that the caller may know the organisation exists, and stamping an
 * org id onto the lines of a request that was refused would put a tenant
 * identifier on another tenant's failed probe.
 */
function bindScope(services: ServiceContext, fields: Record<string, string>): void {
  services.bindLog(fields);
}

/** Resolves a project within an already-resolved organisation. */
export async function resolveProject(
  scope: OrgScope,
  slug: string,
  services: ServiceContext,
): Promise<ProjectScope> {
  const project = await findProjectBySlug(services.db, scope.organization.id, slug);
  if (!project) throw errors.notFound('no project with slug in organisation');

  // A service token is pinned to one project. Reaching any other through it is
  // refused here rather than left to `can()`, so the blast radius of a leaked CI
  // credential is bounded by the credential itself and not by a policy table
  // somebody might later edit (threat T5).
  if (scope.actor.kind === 'serviceToken' && scope.actor.projectId !== project.id) {
    throw errors.notFound('service token project mismatch');
  }

  bindScope(services, { projectId: project.id, projectSlug: project.slug });

  return { ...scope, project };
}

/** Resolves an environment within an already-resolved project. */
export async function resolveEnvironment(
  scope: ProjectScope,
  slug: string,
  services: ServiceContext,
): Promise<EnvironmentScope> {
  // Reached through a join on `projects`, because `environments` has no
  // `org_id` of its own — see the note in the repository.
  const environment = await findEnvironmentBySlug(
    services.db,
    scope.organization.id,
    scope.project.id,
    slug,
  );
  if (!environment) throw errors.notFound('no environment with slug in project');

  if (scope.actor.kind === 'serviceToken' && scope.actor.environmentId !== environment.id) {
    throw errors.notFound('service token environment mismatch');
  }

  bindScope(services, {
    environmentId: environment.id,
    envSlug: environment.slug,
    // The one tenancy fact that changes how a line should be read: a decryption
    // failure in `dev` and the same failure in `production` are not the same
    // incident, and a dashboard that cannot filter on it says so too late.
    isProduction: String(environment.isProduction),
  });

  return { ...scope, environment };
}

/**
 * Convenience resolvers for the common path shapes.
 *
 * Routes call these rather than chaining the three above, so the sequence — and
 * therefore the tenancy chain — cannot be assembled in the wrong order or with a
 * level skipped.
 */
export async function resolveProjectPath(
  principal: Principal,
  params: { orgSlug: string; projectSlug: string },
  services: ServiceContext,
): Promise<ProjectScope> {
  return resolveProject(
    await resolveOrg(principal, params.orgSlug, services),
    params.projectSlug,
    services,
  );
}

export async function resolveEnvironmentPath(
  principal: Principal,
  params: { orgSlug: string; projectSlug: string; envSlug: string },
  services: ServiceContext,
): Promise<EnvironmentScope> {
  return resolveEnvironment(
    await resolveProjectPath(principal, params, services),
    params.envSlug,
    services,
  );
}

/**
 * Authorises an action against a resolved scope.
 *
 * Throws `AuthorizationError`, which the route wrapper turns into a 404 or a
 * 403 according to the decision — so a handler reads linearly and cannot forget
 * to branch on a returned value.
 */
export function authorize(
  scope: OrgScope | ProjectScope | EnvironmentScope,
  action: Action,
  options: { serviceTokenAccessLevel?: AccessLevel | undefined } = {},
): void {
  const environment = 'environment' in scope ? scope.environment : undefined;
  const project = 'project' in scope ? scope.project : undefined;

  const resource: Resource = environment
    ? {
        kind: 'environment',
        orgId: scope.organization.id,
        projectId: environment.projectId,
        environmentId: environment.id,
      }
    : project
      ? { kind: 'project', orgId: scope.organization.id, projectId: project.id }
      : { kind: 'org', orgId: scope.organization.id };

  assertCan(scope.actor, action, resource, {
    membership: scope.membership ? toGrantContext(scope.membership) : undefined,
    serviceToken:
      options.serviceTokenAccessLevel === undefined
        ? undefined
        : { accessLevel: options.serviceTokenAccessLevel },
    // Production is read from the environment row rather than inferred from its
    // slug, so an environment named `prod-eu-west` gets the same protection as
    // one named `production`. `false` for an org- or project-level question is
    // the honest answer: there is no environment in scope.
    isProduction: environment?.isProduction ?? false,
  });
}

/**
 * Runs authorization checks, filing a refusal as a `denied` audit record.
 *
 * A refusal from `authorize()` and one from an authority check in
 * `members-service.ts` both arrive as an `AuthorizationError`; whichever it
 * is, `file` is called once with its decision and the error propagates to
 * become the response. Anything else passes through untouched — a lookup that
 * fails is not a denial.
 *
 * The point is the trail. A burst of `denied` records is how probing shows up
 * in the audit log, and a check that refused without filing one — "grant
 * production `write`", "reinstate the member who holds it", tried in turn by
 * somebody capped below it — would let the probing happen in silence. Routes
 * put every check that can refuse *above the caller's authority* inside one of
 * these, with `file` naming the action that was attempted.
 */
export function auditingDenials(file: (decision: Denial) => void, checks: () => void): void {
  try {
    checks();
  } catch (cause) {
    if (cause instanceof AuthorizationError) file(cause.decision);
    throw cause;
  }
}

/**
 * The part of a stored member the policy layer reads — carried the same way by
 * the caller's own context and by any other member's record.
 *
 * `customRole` is a required key, as it is on the repository's types: a
 * record that never loaded it — a write's `RETURNING` — must not pass for one
 * whose member holds none. Write `customRole: undefined` to say "none".
 */
export type StoredRoleAndStatus = Pick<
  StoredAuthorizationContext,
  'role' | 'status' | 'customRole'
>;

/**
 * Adapts a stored member and their grant rows to the policy layer's
 * `Membership`.
 *
 * The two vocabularies are declared independently on purpose — `@xecret/db`
 * does not import the authorization types, and `@xecret/core/authz` does not
 * know what a table looks like. This function and `toGrantContext`, which is
 * this over the caller's own context, are the seam: every `Membership` built
 * from stored rows is built here — the caller's for `can()`, and a target
 * member's for the authority checks and the effective-access preview.
 *
 * ── Everything that narrows must cross ──
 * Every request-time decision — `authorize()`, the CLI token routes, the
 * key-grant checks in `env-keys-service.ts`, the key reconciliation in
 * `member-keys.ts` — reaches `can()` through here, and every measure of one
 * member against another in `members-service.ts` does too. A field dropped at
 * this seam is not a missing feature, it is a missing restriction: a custom
 * role that never arrives is a member resolved as their unnarrowed built-in
 * role, with every capability and every level the organisation meant to take
 * away.
 */
export function toMembership(
  member: StoredRoleAndStatus,
  grants: readonly Pick<ResolvedGrant, 'projectId' | 'environmentId' | 'accessLevel'>[],
): Membership {
  // `isProduction` is deliberately not part of this mapping: it is a property of
  // the environment being asked about, not of the member, and `can()` takes it
  // separately so it cannot be carried around stale on a membership object.
  return {
    role: member.role,
    memberStatus: member.status,
    // Spread only when present, so a member without one maps to exactly the
    // shape it always did.
    ...(member.customRole === undefined ? {} : { customRole: member.customRole }),
    // Copied field by field, so a storage row's extra columns (its id) never
    // travel into the policy layer.
    grants: grants.map((grant) => ({
      projectId: grant.projectId,
      environmentId: grant.environmentId,
      accessLevel: grant.accessLevel,
    })),
  };
}

/** The caller's own stored context, as the policy layer's `Membership`. */
export function toGrantContext(stored: StoredAuthorizationContext): Membership {
  return toMembership(stored, stored.grants);
}
