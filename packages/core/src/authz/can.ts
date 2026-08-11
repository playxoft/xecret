import { resolveAccessLevel } from './grants';
import type { Membership } from './grants';
import { accessLevelAtLeast, ACTION_REQUIREMENTS, ROLE_CAPABILITIES } from './roles';
import type { RequiredAccessLevel } from './roles';
import type { AccessLevel, Action, Actor, Decision, Resource } from './types';

/**
 * The authorization decision.
 *
 * `can()` is the **only** authorization function in xecret. Every protected
 * route calls it, and no route implements its own check — the moment a second
 * implementation exists the two drift, and the gap between them is the breach
 * (threat T2, the most likely real one).
 *
 * It is total and throw-free. Every input, including a nonsensical one,
 * produces a `Decision`; a denial is an ordinary value that the caller has to
 * read in order to continue. An exception would travel, and somewhere up the
 * stack a `catch` written for a database timeout would turn a denial into a
 * retry, a fallback, or a 200. `assertCan()` exists for handlers that want the
 * throwing form — it is a wrapper over this function, never a second decision
 * procedure.
 */

/**
 * The two messages a denial can carry.
 *
 * Constants, never interpolated. A message that names the project, the action,
 * or an id hands back a fact the caller was just denied the right to learn, and
 * these strings reach API responses, browser consoles, and logs alike.
 */
export const NOT_FOUND_MESSAGE = 'The requested resource does not exist.';
export const FORBIDDEN_MESSAGE = 'You do not have permission to perform this action.';

/** The denial half of a `Decision`, named so callers can map it to a status code. */
export type Denial = Extract<Decision, { allowed: false }>;

/**
 * Byte-identical to the response a genuinely missing resource produces.
 *
 * A cross-tenant request must be indistinguishable from a request for something
 * that was never there. Answering `forbidden` would confirm the resource
 * exists, turning the endpoint into an enumeration oracle: an attacker walks
 * ids and reads the difference between 403 and 404 as a directory of another
 * organisation's projects (threat T2).
 */
function notFound(): Decision {
  return { allowed: false, reason: 'notFound', message: NOT_FOUND_MESSAGE };
}

/** Used only where the actor already provably knows the resource exists. */
function forbidden(): Decision {
  return { allowed: false, reason: 'forbidden', message: FORBIDDEN_MESSAGE };
}

function levelDecision(held: AccessLevel, minimum: RequiredAccessLevel): Decision {
  return accessLevelAtLeast(held, minimum) ? { allowed: true } : forbidden();
}

/**
 * Everything a service token may do, and the level it needs to do it.
 *
 * A positive allowlist rather than a set of exclusions: an `Action` added to the
 * union later is denied to service tokens until somebody consciously adds it
 * here. For a credential that lives in a CI provider's environment variables,
 * quietly gaining a capability is the failure that matters (threat T5).
 *
 * Nothing that manages members, tokens, the organisation, or the audit log
 * appears here, and nothing ever should — a compromised pipeline must not be
 * able to mint itself a second credential or erase its own tracks.
 *
 * The levels agree with `ACTION_REQUIREMENTS`; the test file asserts it, so a
 * change to one that is not mirrored in the other fails the build.
 */
export const SERVICE_TOKEN_ACTIONS: Readonly<Partial<Record<Action, RequiredAccessLevel>>> = {
  'secret.read': 'read',
  'secret.create': 'write',
  'secret.update': 'write',
};

/** A service token's own authority. It has no user behind it and inherits none. */
export interface ServiceTokenContext {
  accessLevel: AccessLevel;
}

/** Everything `can()` needs that is not in the actor, the action, or the resource. */
export interface AuthorizationContext {
  /**
   * The `org_members` row for the acting user, with their grants.
   *
   * Absent for a `serviceToken` actor, which has no membership. Absent for a
   * user means "not a member of this organisation", and is denied as
   * `notFound`.
   */
  membership?: Membership | undefined;

  /** Required for a `serviceToken` actor, ignored for every other kind. */
  serviceToken?: ServiceTokenContext | undefined;

  /**
   * Whether the environment named by `resource` is flagged production.
   *
   * Required, not optional-defaulting-to-false. The one value nobody may forget
   * is the one whose default would hand a developer write access to production.
   * For an org or project resource there is no environment and `false` is the
   * honest answer.
   */
  isProduction: boolean;
}

/**
 * Decides whether `actor` may perform `action` on `resource`.
 *
 * Never throws, never consults the network or the clock, and depends on nothing
 * but its arguments — the same four inputs always produce the same decision,
 * which is what makes the security matrix in `authz.test.ts` meaningful.
 */
export function can(
  actor: Actor,
  action: Action,
  resource: Resource,
  context: AuthorizationContext,
): Decision {
  // Tenancy first, ahead of every other consideration, so that no later branch
  // can answer a cross-tenant question with anything other than `notFound` —
  // not even for an owner, and not even for an action nobody is allowed to
  // perform.
  if (actor.orgId !== resource.orgId) return notFound();

  if (actor.kind === 'serviceToken') {
    return serviceTokenDecision(actor, action, resource, context.serviceToken);
  }

  // `user` and `cliToken` share one path on purpose. A CLI token is a delivery
  // mechanism for a user's identity, not an identity of its own: it is issued to
  // one person, it carries their role and their grants, and it is revoked when
  // they leave. Giving it any authority the user does not have would mean a
  // stolen laptop (threat T4) is worse than a stolen password, and giving it
  // less would mean the CLI silently does less than the dashboard.
  return memberDecision(action, resource, context);
}

function serviceTokenDecision(
  actor: Extract<Actor, { kind: 'serviceToken' }>,
  action: Action,
  resource: Resource,
  serviceToken: ServiceTokenContext | undefined,
): Decision {
  // A service token is pinned to exactly one project and one environment — the
  // whole blast-radius control for a compromised pipeline. Anything outside that
  // pair is reported as missing rather than forbidden, so a token leaked from CI
  // cannot be used to map the rest of the organisation (threat T5).
  if (resource.kind === 'org') return forbidden();
  if (resource.projectId !== actor.projectId) return notFound();
  if (resource.kind === 'environment' && resource.environmentId !== actor.environmentId) {
    return notFound();
  }

  const minimum = SERVICE_TOKEN_ACTIONS[action];
  if (minimum === undefined) return forbidden();

  // Every allowlisted action operates on secrets, which live in an environment;
  // a project-level resource cannot satisfy one.
  if (resource.kind !== 'environment') return forbidden();

  // Deny-closed: a caller that routes a service token here without loading its
  // row has proved nothing about its access level, and a missing context must
  // never read as an unrestricted one.
  if (serviceToken === undefined) return forbidden();

  return levelDecision(serviceToken.accessLevel, minimum);
}

function memberDecision(
  action: Action,
  resource: Resource,
  context: AuthorizationContext,
): Decision {
  const membership = context.membership;

  // The actor claims this organisation but holds no membership row in it, which
  // means the claim is stale — a removed member replaying a live session. They
  // must not be able to tell the organisation's resources apart from ones that
  // never existed.
  if (membership === undefined) return notFound();

  // Suspension is a whole-account revocation, checked before capabilities so it
  // covers org-level actions too, which no grant is consulted for.
  if (membership.memberStatus !== 'active') return forbidden();

  if (!ROLE_CAPABILITIES[membership.role][action]) return forbidden();

  const requirement = ACTION_REQUIREMENTS[action];
  if (requirement.scope === 'org') return { allowed: true };

  // A resource-scoped action addressed at the organisation is a caller bug.
  // Denying beats throwing: a thrown error on one route becomes a 500 that an
  // operator may be tempted to route around, whereas a denial is simply wrong
  // in the safe direction and shows up the first time the route is exercised.
  if (resource.kind === 'org') return forbidden();

  if (requirement.scope === 'environment') {
    if (resource.kind !== 'environment') return forbidden();

    return levelDecision(
      resolveAccessLevel(
        { ...membership, isProduction: context.isProduction },
        resource.projectId,
        resource.environmentId,
      ),
      requirement.minimum,
    );
  }

  // Project scope. `isProduction` is forced to `false` here even when the
  // request arrived through a production environment: production is a property
  // of an environment, and letting it apply to a project-level question would
  // deny a developer the project itself because of where the link came from.
  return levelDecision(
    resolveAccessLevel({ ...membership, isProduction: false }, resource.projectId, null),
    requirement.minimum,
  );
}

/**
 * A denial, as an exception.
 *
 * Carries the whole `Decision` so the error handler can map `reason` to 404 or
 * 403 without re-deciding anything, and so the audit record of the denial says
 * the same thing the client was told.
 */
export class AuthorizationError extends Error {
  constructor(readonly decision: Denial) {
    super(decision.message);
    this.name = 'AuthorizationError';
  }
}

/**
 * `can()` with the denial raised instead of returned.
 *
 * For route handlers whose happy path reads better as a straight line. It adds
 * no logic of its own — there is still exactly one place where a decision is
 * made.
 */
export function assertCan(
  actor: Actor,
  action: Action,
  resource: Resource,
  context: AuthorizationContext,
): void {
  const decision = can(actor, action, resource, context);
  if (!decision.allowed) throw new AuthorizationError(decision);
}
