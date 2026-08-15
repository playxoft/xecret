import { assertCan } from '@xecret/core/authz';
import type {
  AccessLevel,
  Action,
  Actor,
  Membership,
  Resource,
  ResolvedGrant,
} from '@xecret/core/authz';
import {
  findEnvironmentBySlug,
  findOrganizationBySlug,
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
  const organization = await findOrganizationBySlug(services.db, slug);
  if (!organization) throw errors.notFound(`no organisation with slug`);

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
 * Adapts the storage layer's context to the policy layer's.
 *
 * The two are declared independently on purpose — `@xecret/db` does not import
 * the authorization types, and `@xecret/core/authz` does not know what a table
 * looks like. This function is the seam, and it is the only place the two
 * vocabularies meet.
 */
export function toGrantContext(stored: StoredAuthorizationContext): Membership {
  const grants: ResolvedGrant[] = stored.grants.map((grant) => ({
    projectId: grant.projectId,
    environmentId: grant.environmentId,
    accessLevel: grant.accessLevel,
  }));

  // `isProduction` is deliberately not part of this mapping: it is a property of
  // the environment being asked about, not of the member, and `can()` takes it
  // separately so it cannot be carried around stale on a membership object.
  return { role: stored.role, memberStatus: stored.status, grants };
}
