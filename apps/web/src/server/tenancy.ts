import { assertCan, AuthorizationError } from '@xecret/core/authz';
import type {
  AccessLevel,
  Action,
  Actor,
  Membership,
  Resource,
  ResolvedGrant,
} from '@xecret/core/authz';
import type { Entitlements } from '@xecret/core/entitlements';
import {
  entitlementsFromRow,
  findEnvironmentBySlug,
  findOrganizationBySlugWithEntitlements,
  findProjectById,
  findProjectBySlug,
  loadAuthorizationContext,
} from '@xecret/db/repositories';
import type {
  AuthorizationContext as StoredAuthorizationContext,
  EnvironmentRecord,
  Organization,
  ProjectRecord,
} from '@xecret/db/repositories';
import type { CredentialSignIn, Principal } from './actor';
import type { ServiceContext } from './context';
import { requireControlPlane } from './entitlements';
import { errors } from './errors';
import { isUuid } from './schemas/ids';

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
 * a slug in another organisation, another organisation's project id, a project
 * they hold no grant on, an environment outside a service token's pin. They are
 * indistinguishable from a genuinely absent resource on purpose. Answering
 * `forbidden` would confirm the resource exists, which is a directory of
 * another tenant's projects.
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
 * How a route reaches its organisation, beyond the slug.
 *
 * `controlPlane: 'exempt'` is for the few writes an organisation whose control
 * plane is closed must still accept (see `guardControlPlane`). Every other
 * write is gated by default, so a new route cannot forget the gate: leaving it
 * on takes nothing, and taking it off has to be said, at the call, where a
 * reviewer reads it.
 */
export interface ResolveOrgOptions {
  controlPlane?: 'exempt' | undefined;
}

/** The methods that only read. Every other request to an organisation writes to it. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a write to an organisation whose control plane is closed: one
 * awaiting a paid plan (past its creator's free allowance) or one whose
 * subscription has lapsed. See `Entitlements.controlPlaneActive`.
 *
 * ── One place, by method ──
 * Every route below `/api/orgs/{orgSlug}` resolves its organisation here, so
 * this is the one gate every one of them passes. It is keyed on the request's
 * method rather than on the action a route authorises, because several reads
 * authorise a write's capability (the service tokens are listed for whoever may
 * mint or revoke one, the webhooks for whoever may change them), and those
 * must keep answering. A read is never refused for a billing reason: the data
 * plane (the CLI's pulls, a service token's fetches, the dashboard's listings)
 * keeps working, and nothing is deleted.
 *
 * ── What stays open ──
 * The routes that pass `controlPlane: 'exempt'`, and only for the reason each
 * states: the billing routes (checkout, plan change, the portal, promo codes),
 * because paying is how the organisation is opened; deleting the organisation;
 * revoking a token, removing a member and withdrawing an invitation, because
 * taking access away must never wait on a payment; and the CLI's device
 * sign-in, because that is how a person reads secrets from a terminal at all.
 *
 * After the membership and single sign-on checks, so a stranger still learns
 * nothing about the organisation and a member is told the first thing that
 * actually stands in the way.
 */
function guardControlPlane(
  entitlements: Entitlements,
  services: Pick<ServiceContext, 'meta'>,
  options: ResolveOrgOptions,
): void {
  if (options.controlPlane === 'exempt') return;
  // Absent only from the stubbed contexts of the tenancy unit tests, which
  // resolve without a request; the route wrapper always stamps it.
  const method = (services.meta as ServiceContext['meta'] | undefined)?.method ?? 'GET';
  if (READ_METHODS.has(method.toUpperCase())) return;
  requireControlPlane(entitlements);
}

/**
 * Resolves an organisation slug for the current principal.
 *
 * Note the order: the organisation is looked up first, then membership, and a
 * miss at *either* step produces the same `not_found`. Checking membership first
 * and reporting "no such organisation" separately would let an attacker
 * enumerate which slugs are taken.
 *
 * A write to an organisation whose control plane is closed is refused here as
 * well, unless the route says it is one of the few that stay open: see
 * `guardControlPlane`.
 */
export async function resolveOrg(
  principal: Principal,
  slug: string,
  services: ServiceContext,
  options: ResolveOrgOptions = {},
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
    guardControlPlane(entitlements, services, options);

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

  // After the membership, never before: a stranger is answered `not_found`
  // like any other, and only a member learns that the organisation wants its
  // single sign-on. See `ssoRequirementRefuses`.
  if (ssoRequirementRefuses(organization, membership.role, principal.signIn)) {
    throw errors.ssoRequired(
      `organisation requires SSO; this ${principal.kind === 'user' ? 'session' : 'CLI token'} ` +
        `signed in by ${principal.signIn.method ?? 'an unrecorded method'}`,
    );
  }

  bindScope(services, { orgId: organization.id, orgSlug: organization.slug });
  guardControlPlane(entitlements, services, options);

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
 * Whether an organisation's `sso_required` refuses this credential — the
 * per-request half of the requirement, and the half that counts.
 *
 * It used to be checked once, at sign-in, which left three ways round it: a
 * session issued before the flag went on (thirty days of it), a CLI token
 * minted from one (whose expiry may be never), and a newcomer who signed in
 * with a password and then accepted an invitation. So it is checked here, on
 * every request that reaches the organisation, against how the presenting
 * credential signed in (`Principal['signIn']`, migration 0022): the moment the
 * flag is on, every non-SSO credential loses this organisation — and only this
 * one; the member's other organisations are untouched.
 *
 * Refuses unless one of these holds:
 *
 *  - The organisation does not require SSO.
 *  - The member is an **owner** — the deliberate break-glass (a misconfigured
 *    identity provider must not lock the organisation out of itself), audited
 *    at each sign-in that uses it (`auth.sso_exemption_used`).
 *  - The credential came through **this** organisation's single sign-on: its
 *    recorded WorkOS organisation is this one's `workos_org_id`. A credential
 *    issued before the method was recorded carries none, and is refused.
 *
 * A link made in another WorkOS environment (review S9) can never be satisfied
 * here — no credential in this environment comes through it — so only owners
 * reach such an organisation, which is the right outcome for a link nobody here
 * can sign in through.
 */
export function ssoRequirementRefuses(
  organization: Pick<Organization, 'ssoRequired' | 'workosOrgId'>,
  role: StoredAuthorizationContext['role'],
  signIn: Pick<CredentialSignIn, 'ssoWorkosOrgId'>,
): boolean {
  if (!organization.ssoRequired) return false;
  if (role === 'owner') return false;
  if (organization.workosOrgId === null) return true;
  return signIn.ssoWorkosOrgId !== organization.workosOrgId;
}

/**
 * Whether a credential reaches this organisation only by the owner exemption:
 * the organisation requires its single sign-on, the credential did not come
 * through it, and the member is an owner. What the places that *create* a
 * credential on the strength of it — the sign-in, a CLI approval, an owner's
 * invitation — file as `auth.sso_exemption_used` (review round 2).
 */
export function usesOwnerSsoExemption(
  organization: Pick<Organization, 'ssoRequired' | 'workosOrgId'>,
  role: StoredAuthorizationContext['role'],
  signIn: Pick<CredentialSignIn, 'ssoWorkosOrgId'>,
): boolean {
  return (
    organization.ssoRequired &&
    role === 'owner' &&
    (organization.workosOrgId === null || signIn.ssoWorkosOrgId !== organization.workosOrgId)
  );
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

/**
 * Resolves a project within an already-resolved organisation, by its id or by
 * its slug.
 *
 * ── Why either ──
 * The dashboard names a project by its id (`/app/{org}/{projectId}/…`), so an
 * address never spells out what a project is called, and calls the API with
 * the segment its own URL holds. The CLI, `.xecret.yaml` and every CI configuration name it by slug, and
 * must keep working unchanged. One segment serves both, told apart by shape: a
 * canonical lowercase UUID is an id, anything else is a slug. No slug can take
 * that shape — `checkSlug` refuses one at creation — so the reading is never
 * ambiguous; and an id is never retried as a slug, so a segment means one thing
 * whichever lookup answers it.
 *
 * ── Why an id is no shortcut past the tenancy chain ──
 * The id is accepted only here, beneath an organisation this principal has
 * already been resolved into, and `findProjectById` filters on that
 * organisation's id as well as the project's. Another tenant's project id is
 * therefore exactly the `not_found` an unknown slug is — same branch, same
 * answer — and the service-token pin below applies to both spellings.
 */
export async function resolveProject(
  scope: OrgScope,
  segment: string,
  services: ServiceContext,
): Promise<ProjectScope> {
  const project = isUuid(segment)
    ? await findProjectById(services.db, scope.organization.id, segment)
    : await findProjectBySlug(services.db, scope.organization.id, segment);
  if (!project) throw errors.notFound('no project with that id or slug in organisation');

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
 *
 * `projectSlug` is the route folder's name, `[projectSlug]`, and it holds the
 * project's slug *or its id* — whichever the caller addressed it by; see
 * `resolveProject`. The folder keeps the name it has always had because every
 * route below it, and every client that calls one, is unaffected by which of the
 * two arrives: the resolved scope carries the project row, and the routes read
 * `scope.project.slug` for anything they record.
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
 * `authorize` for a request that any one of several actions permits — a
 * listing shared by people who act on it in different ways, such as the
 * service tokens, which both minting and revoking need to see.
 *
 * Refused only when every action is, and then with the *first* action's
 * refusal, so the answer — a 404 or a 403 — is the one the primary action
 * would have given on its own.
 */
export function authorizeAny(
  scope: OrgScope | ProjectScope | EnvironmentScope,
  actions: readonly [Action, ...Action[]],
): void {
  let refusal: AuthorizationError | null = null;
  for (const action of actions) {
    try {
      authorize(scope, action);
      return;
    } catch (cause) {
      if (!(cause instanceof AuthorizationError)) throw cause;
      refusal ??= cause;
    }
  }
  throw refusal;
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
