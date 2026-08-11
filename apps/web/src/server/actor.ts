import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  evaluateSession,
  hashToken,
  isSafeMethod,
  isWellFormedToken,
  shouldTouchSession,
  verifyCsrf,
} from '@xecret/core/auth';
import type { AccessLevel } from '@xecret/core/authz';
import {
  findCliTokenByHash,
  findServiceTokenByHash,
  findSessionByTokenHash,
  isIpAllowed,
  touchCliTokenUsage,
  touchServiceTokenUsage,
  touchSession,
} from '@xecret/db/repositories';
import type { SessionUser } from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { bearerToken, parseCookies } from './http';

/**
 * Authentication: turning a credential on a request into a principal.
 *
 * Authentication answers "who is this?". It deliberately does **not** answer
 * "what may they do?" — that is `can()` in `@xecret/core/authz`, and keeping the
 * two apart is what stops a route from accidentally treating "presented a valid
 * token" as "may read this environment".
 *
 * A principal is not yet an `Actor`. An `Actor` is scoped to an organisation,
 * and for a session or a CLI token the organisation comes from the request path,
 * not from the credential. Resolving that is `tenancy.ts`'s job, and it is a
 * separate step because it is the step that must consult membership.
 */

/** A CLI token acts as its user; a service token acts as nobody. */
export type Principal =
  | { kind: 'user'; sessionId: string; user: SessionUser }
  | {
      kind: 'cliToken';
      tokenId: string;
      tokenName: string;
      /**
       * The user the token was issued to. Authorization resolves this user's
       * membership and grants — the token adds no authority of its own.
       *
       * The profile behind it is deliberately not loaded here. Authentication
       * needs the id; only `whoami` needs the email, and making every CLI call
       * pay for a join it does not use is the wrong default.
       */
      userId: string;
      orgId: string;
    }
  | {
      kind: 'serviceToken';
      tokenId: string;
      tokenName: string;
      orgId: string;
      projectId: string;
      environmentId: string;
      accessLevel: AccessLevel;
    };

/** How the credential arrived. Decides whether CSRF applies. */
export type CredentialSource = 'cookie' | 'bearer';

export interface Authentication {
  principal: Principal;
  source: CredentialSource;
}

/**
 * Resolves the credential on a request.
 *
 * Presenting both a cookie and a bearer token is rejected rather than resolved
 * by precedence. Silently preferring one would mean a CSRF-able ambient cookie
 * could authorise a call the client believed was bearer-authenticated — and
 * whichever precedence is chosen, some caller is surprised. There is no
 * legitimate client that sends both.
 */
export async function authenticate(
  request: Request,
  services: ServiceContext,
): Promise<Authentication> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const sessionToken = cookies.get(SESSION_COOKIE_NAME) ?? null;
  const bearer = bearerToken(request);

  if (sessionToken !== null && bearer !== null) {
    throw errors.unauthenticated('both cookie and bearer credentials presented');
  }

  if (sessionToken !== null) {
    return { principal: await principalFromSession(sessionToken, services), source: 'cookie' };
  }

  if (bearer !== null) {
    return { principal: await principalFromBearer(bearer, services), source: 'bearer' };
  }

  throw errors.unauthenticated('no credential');
}

async function principalFromSession(token: string, services: ServiceContext): Promise<Principal> {
  // A structural check first, so a junk cookie costs a regular expression rather
  // than a digest and a database round trip.
  if (!isWellFormedToken(token, 'session')) {
    throw errors.unauthenticated('malformed session token');
  }

  const now = new Date();
  const session = await findSessionByTokenHash(services.db, await hashToken(token), now);
  if (!session) throw errors.unauthenticated('session unknown');

  // The policy lives in @xecret/core/auth and is unit-tested without a database,
  // so "what counts as a valid session" has exactly one definition. The query
  // has already excluded revoked and absolutely-expired rows — this additionally
  // applies the idle rule, which is not expressible as a cheap indexed filter.
  const resolution = evaluateSession(session, now);
  if (!resolution.ok) throw errors.unauthenticated(`session ${resolution.reason}`);

  // Throttled to at most one write per five minutes, and deferred past the
  // response: a page load must not become a database write just to move a
  // timestamp, and the user must not wait for it when it does.
  if (shouldTouchSession(resolution.session, now)) {
    services.waitUntil(touchSession(services.db, session.id, now));
  }

  return { kind: 'user', sessionId: session.id, user: session.user };
}

async function principalFromBearer(token: string, services: ServiceContext): Promise<Principal> {
  const hash = await hashToken(token);

  // The prefix decides which table is consulted, so a CLI token can never be
  // resolved against the service-token table or the reverse. The two live in
  // separate tables precisely so a CI credential cannot act as a person (T5),
  // and a single lookup across both would give that property away.
  if (isWellFormedToken(token, 'cli')) {
    const record = await findCliTokenByHash(services.db, hash);
    if (!record) throw errors.unauthenticated('unknown cli token');

    // Usage tracking is bookkeeping, not a precondition. Awaiting it would add a
    // write to every CLI call for a column nothing reads on the hot path.
    services.waitUntil(touchCliTokenUsage(services.db, record.id, services.meta.ipAddress));

    return {
      kind: 'cliToken',
      tokenId: record.id,
      tokenName: record.name,
      userId: record.userId,
      orgId: record.orgId,
    };
  }

  if (isWellFormedToken(token, 'service')) {
    const record = await findServiceTokenByHash(services.db, hash);
    if (!record) throw errors.unauthenticated('unknown service token');

    if (!sourceAddressAllowed(record.ipAllowlist, services.meta.ipAddress)) {
      // Reported as an ordinary authentication failure, not as a distinct "your
      // IP is not allowed". Distinguishing them would confirm to whoever stole
      // the token that it is otherwise valid, and tell them what to fix.
      throw errors.unauthenticated('service token ip not allowed');
    }

    services.waitUntil(touchServiceTokenUsage(services.db, record.id, services.meta.ipAddress));

    return {
      kind: 'serviceToken',
      tokenId: record.id,
      tokenName: record.name,
      orgId: record.orgId,
      projectId: record.projectId,
      environmentId: record.environmentId,
      accessLevel: record.accessLevel,
    };
  }

  throw errors.unauthenticated('unrecognised bearer token');
}

/**
 * Applies a service token's IP allowlist to the observed source address.
 *
 * The case `isIpAllowed` cannot express is an *unknown* address. That happens
 * when `CF-Connecting-IP` is absent — outside Cloudflare's edge, or in a local
 * `next dev` run. An empty allowlist still means "anywhere", but once an
 * operator has written one down, an address we cannot see must not satisfy it:
 * treating unknown as allowed would turn the allowlist off for exactly the
 * traffic that did not arrive the expected way.
 */
function sourceAddressAllowed(
  allowlist: readonly string[] | null | undefined,
  ip: string | null,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (ip === null) return false;
  return isIpAllowed(allowlist, ip);
}

/**
 * Enforces the CSRF double-submit pair on cookie-authenticated mutations.
 *
 * Applies to cookies only. A bearer request carries no ambient credential for a
 * browser to attach automatically, so there is nothing for an attacker's page to
 * exploit — and requiring a CSRF token there would break the CLI for no gain.
 */
export function assertCsrf(request: Request, source: CredentialSource): void {
  if (source !== 'cookie' || isSafeMethod(request.method)) return;

  const cookies = parseCookies(request.headers.get('cookie'));
  const result = verifyCsrf(
    cookies.get(CSRF_COOKIE_NAME) ?? null,
    request.headers.get(CSRF_HEADER_NAME),
  );

  if (!result.ok) throw errors.csrf(result.reason);
}

/**
 * How this principal should read in an audit record.
 *
 * The label is denormalised onto the row at write time, so it must still make
 * sense after the user or the token is deleted — which is why it names the
 * credential as well as the person. During an incident, "who" and "how" are
 * separate questions, and a log that only answers the first is half a log.
 */
export function actorLabel(principal: Principal): string {
  switch (principal.kind) {
    case 'user':
      return principal.user.email;
    case 'cliToken':
      return `${principal.tokenName} (CLI token)`;
    case 'serviceToken':
      return `${principal.tokenName} (service token)`;
  }
}

/** The user this principal acts as, or null for a service token. */
export function actingUserId(principal: Principal): string | null {
  switch (principal.kind) {
    case 'user':
      return principal.user.id;
    case 'cliToken':
      return principal.userId;
    case 'serviceToken':
      // Structurally null, not merely absent. A CI credential has no person
      // behind it and must never be able to act as one (threat T5).
      return null;
  }
}

/** The audit `actor_type` for this principal. */
export function actorType(principal: Principal): 'user' | 'cli_token' | 'service_token' {
  switch (principal.kind) {
    case 'user':
      return 'user';
    case 'cliToken':
      return 'cli_token';
    case 'serviceToken':
      return 'service_token';
  }
}

/** The id recorded as the audit actor. */
export function actorId(principal: Principal): string {
  return principal.kind === 'user' ? principal.user.id : principal.tokenId;
}
