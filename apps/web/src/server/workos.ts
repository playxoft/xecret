import { GenerateLinkIntent, WorkOS } from '@workos-inc/node';
import { IdentityVerificationError, workosIdentity } from '@xecret/core/auth';
import type {
  AuthorizationCodeExchange,
  CodeExchangeContext,
  IdentityProvider,
  VerifiedIdentity,
  WorkosIdentity,
} from '@xecret/core/auth';
import type { Bindings } from './bindings';
import { MissingBindingError, publicOrigin } from './bindings';

/**
 * WorkOS, at the one boundary where xecret talks to it.
 *
 * WorkOS authenticates a person; xecret decides what that person may do. The
 * authorization code AuthKit hands back is exchanged **exactly once**, in the
 * sign-in callback, for the WorkOS user it names — and the access and refresh
 * tokens that come with it are dropped on the floor. From there the credential
 * is an xecret session, which can be listed and revoked instantly. ADR 0010 has
 * the reasoning; it is ADR 0003's, with the provider swapped.
 *
 * ── Why `@workos-inc/node` and not `@workos-inc/authkit-nextjs` ──
 * The Next.js package is built around `authkitMiddleware` and its own sealed
 * session cookie. This deployment has no middleware and cannot have one (ADR
 * 0008), and it already has a session. What it needs from WorkOS is four HTTP
 * calls, and that is what this file makes. `eslint.config.mjs` bans the other
 * package so it cannot arrive by accident.
 *
 * ── Runtime ──
 * The SDK is fetch-based and resolves to its `workerd` build under OpenNext:
 * no `fs`, no Node crypto, and no dependencies of its own (its JWT library is
 * bundled, and only reached by session-cookie helpers this file never calls).
 *
 * ── What is never done here ──
 * Nothing decodes a token. Every fact about a person comes back from an
 * authenticated API call this server made with its own secret key — the code
 * exchange, the Magic Auth check — so there is no signature for a client to
 * forge and no audience for one to get wrong.
 */

/**
 * The slice of the SDK this module calls.
 *
 * Picked from the SDK's own types rather than restated, so the compiler checks
 * that every call made here exists on the installed client with the shape it is
 * called with — a restated interface plus a cast would compile against a member
 * the SDK renamed, and fail at the first sign-in. A test hands in a stub that
 * answers exactly these calls, and the list is something a reviewer can read in
 * one place: these are all the WorkOS capabilities xecret depends on.
 */
export interface WorkosApi {
  userManagement: Pick<
    WorkOS['userManagement'],
    'getAuthorizationUrl' | 'authenticateWithCode' | 'createMagicAuth' | 'authenticateWithMagicAuth'
  >;
  organizations: Pick<WorkOS['organizations'], 'getOrganization' | 'createOrganization'>;
  adminPortal: Pick<WorkOS['adminPortal'], 'generateLink'>;
  sso: Pick<WorkOS['sso'], 'listConnections'>;
}

/** The parts of an authentication response this module reads. Everything else is ignored. */
export interface WorkosAuthentication {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    firstName: string | null;
    lastName: string | null;
    profilePictureUrl: string | null;
  };
  organizationId?: string | undefined;
  authenticationMethod?: string | undefined;
  impersonator?: { email: string; reason: string | null } | undefined;
}

/**
 * The longest authorization or Magic Auth code accepted.
 *
 * WorkOS codes are short (a ULID, or six digits); the bound exists so that a
 * hostile query string is refused on shape, before it is forwarded anywhere.
 */
export const MAX_CODE_LENGTH = 256;

/** RFC 3986 unreserved characters — what an authorization code can be made of. */
const CODE_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** A Magic Auth code: six digits. */
const MAGIC_AUTH_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * The provider could not be asked, as opposed to answering "no".
 *
 * Its own class because the two need opposite responses: a refused code is the
 * caller's problem and a 4xx; an unreachable or misconfigured provider is ours,
 * a 503, and something an operator has to be paged for. Collapsing them would
 * either blame users for an outage or page somebody every time a link expired.
 */
export class IdentityProviderUnavailableError extends Error {
  constructor(
    /** `misconfigured` (our key was refused), `rate-limited`, or `unreachable`. */
    readonly reason: 'misconfigured' | 'rate-limited' | 'unreachable',
  ) {
    super('The identity provider could not be reached');
    this.name = 'IdentityProviderUnavailableError';
  }
}

/** Configuration the provider needs. Read from the bindings by {@link workosProvider}. */
export interface WorkosConfig {
  clientId: string;
  /** `${publicOrigin}/api/auth/callback` — derived, never configured separately. */
  redirectUri: string;
}

export class WorkosIdentityProvider implements IdentityProvider<WorkosIdentity> {
  readonly #api: WorkosApi;
  readonly #config: WorkosConfig;

  constructor(api: WorkosApi, config: WorkosConfig) {
    this.#api = api;
    this.#config = config;
  }

  /**
   * Where to send the browser to sign in.
   *
   * PKCE is used even though this is a confidential client, as OAuth 2.1
   * recommends: the verifier lives in the browser's HttpOnly state cookie, so a
   * code lifted from the redirect — out of a history entry, a referrer, a proxy
   * log — cannot be exchanged by anyone who does not also hold that cookie.
   */
  authorizationUrl(params: {
    state: string;
    codeChallenge: string;
    /** A WorkOS organisation id, to start that organisation's SSO directly. */
    organizationId?: string | undefined;
    screenHint?: 'sign-up' | 'sign-in' | undefined;
    /**
     * Ask the provider to make the person authenticate again even if it holds a
     * session for them. `0` is the only value this application uses: see the
     * reauth purpose in `server/sign-in.ts`.
     */
    maxAge?: number | undefined;
  }): string {
    return this.#api.userManagement.getAuthorizationUrl({
      // An SSO deep link names the organisation instead of the provider:
      // WorkOS takes exactly one of the two.
      ...(params.organizationId === undefined
        ? { provider: 'authkit' }
        : { organizationId: params.organizationId }),
      clientId: this.#config.clientId,
      redirectUri: this.#config.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      ...(params.screenHint === undefined ? {} : { screenHint: params.screenHint }),
      ...(params.maxAge === undefined ? {} : { maxAge: params.maxAge }),
    });
  }

  /**
   * Exchanges an authorization code for the identity behind it.
   *
   * One authenticated call to WorkOS, made with this deployment's secret key and
   * the flow's PKCE verifier. The `user` it returns is minted into a
   * `WorkosIdentity` **here and only here**, from the response object itself —
   * the linking pass refuses anything `workosIdentity()` did not mint, including
   * a copy of something it did, so the result must be passed on as it is.
   */
  async exchangeCode(
    code: string,
    context: CodeExchangeContext,
  ): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
    assertCodeShape(code, CODE_PATTERN);

    let response: WorkosAuthentication;
    try {
      response = await this.#api.userManagement.authenticateWithCode({
        clientId: this.#config.clientId,
        code,
        codeVerifier: context.codeVerifier,
        ...requestFacts(context),
      });
    } catch (cause) {
      throw providerFailure(cause);
    }

    return this.#toExchange(response);
  }

  /**
   * Starts a Magic Auth challenge: WorkOS creates a one-time code for `email`
   * and emails it (the API's documented behaviour while the environment's
   * default Magic Auth email is on — see the deployment-check skill).
   *
   * WorkOS's response carries the code as well, so that an application which
   * sends its own email can. This one does not, and the code is dropped here,
   * unread: the one copy this server ever holds must not reach a caller, a log
   * or an audit row. What is returned is only whose WorkOS user the address
   * reached.
   */
  async createMagicAuth(
    email: string,
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<{ workosUserId: string; expiresAt: string }> {
    try {
      const created = await this.#api.userManagement.createMagicAuth({
        email,
        ...requestFacts(context),
      });
      return { workosUserId: created.userId, expiresAt: created.expiresAt };
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /**
   * Checks a Magic Auth code, and says which WorkOS user it proved control of.
   *
   * The authentication this produces at WorkOS is discarded with its tokens, the
   * same as a sign-in's. What the caller needs is only whose inbox the code
   * reached — and whether somebody was impersonating them while it did.
   */
  async authenticateWithMagicAuth(
    params: { code: string; email: string },
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<{ workosUserId: string; impersonated: boolean }> {
    assertCodeShape(params.code, MAGIC_AUTH_CODE_PATTERN);

    let response: WorkosAuthentication;
    try {
      response = await this.#api.userManagement.authenticateWithMagicAuth({
        clientId: this.#config.clientId,
        code: params.code,
        email: params.email,
        ...requestFacts(context),
      });
    } catch (cause) {
      throw providerFailure(cause);
    }

    return { workosUserId: response.user.id, impersonated: response.impersonator !== undefined };
  }

  /**
   * The domains a WorkOS organisation has *verified*, lower-cased.
   *
   * What an SSO sign-in's address is checked against before the linking pass
   * runs: an organisation's identity provider may assert any address it likes,
   * and is only believed for the domains the organisation proved it owns.
   */
  async verifiedDomains(workosOrgId: string): Promise<ReadonlySet<string>> {
    try {
      const organization = await this.#api.organizations.getOrganization(workosOrgId);
      return new Set(
        organization.domains
          .filter((entry) => entry.state === 'verified')
          .map((entry) => entry.domain.toLowerCase()),
      );
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /**
   * For the organisation SSO settings (WS-5), which have no caller yet: create
   * the WorkOS organisation an xecret organisation's SSO will hang off.
   */
  async createOrganization(params: { name: string; externalId: string }): Promise<string> {
    try {
      const created = await this.#api.organizations.createOrganization(params);
      return created.id;
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /** For WS-5: an Admin Portal link for the organisation's IT admin to configure SSO. */
  async generatePortalLink(params: { workosOrgId: string; returnUrl: string }): Promise<string> {
    try {
      const { link } = await this.#api.adminPortal.generateLink({
        organization: params.workosOrgId,
        intent: GenerateLinkIntent.SSO,
        returnUrl: params.returnUrl,
      });
      return link;
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /** For WS-5: the organisation's SSO connections, for a status display. */
  async listConnections(workosOrgId: string) {
    try {
      const { data } = await this.#api.sso.listConnections({ organizationId: workosOrgId });
      return data.map(({ id, state, type }) => ({ id, state, type }));
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  #toExchange(response: WorkosAuthentication): AuthorizationCodeExchange<WorkosIdentity> {
    const user = response.user;
    if (typeof user.email !== 'string' || user.email === '') {
      // Every xecret account is keyed by email — invitations are addressed to
      // it and audit records name it. A WorkOS user without one has nowhere to
      // attach. (WorkOS always sets it; a stub in a test may not.)
      throw new IdentityVerificationError('no-email');
    }

    const verified: VerifiedIdentity = {
      subject: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      // D5: the moment of the exchange. The code was minted by an
      // authentication that just happened, and it can be exchanged once.
      authTime: Math.floor(Date.now() / 1000),
    };
    // `exactOptionalPropertyTypes`: an absent field must be absent, not
    // present-and-undefined.
    const displayName = [user.firstName, user.lastName]
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
      .join(' ');
    if (displayName !== '') verified.displayName = displayName;
    if (typeof user.profilePictureUrl === 'string' && user.profilePictureUrl !== '') {
      verified.avatarUrl = user.profilePictureUrl;
    }

    return {
      // Minted once, from the response, and passed on as this exact object.
      identity: workosIdentity(verified),
      organizationId: nonEmpty(response.organizationId),
      authenticationMethod: nonEmpty(response.authenticationMethod),
      impersonator:
        response.impersonator === undefined ? null : { email: response.impersonator.email },
    };
  }
}

function assertCodeShape(code: string, pattern: RegExp): void {
  // A structural check before any work: WorkOS will refuse this anyway, but
  // not before an attacker-chosen string has been forwarded to it.
  if (typeof code !== 'string' || code === '' || code.length > MAX_CODE_LENGTH) {
    throw new IdentityVerificationError('malformed-code');
  }
  if (!pattern.test(code)) throw new IdentityVerificationError('malformed-code');
}

function requestFacts(context: { ipAddress: string | null; userAgent: string | null }) {
  return {
    ...(context.ipAddress === null ? {} : { ipAddress: context.ipAddress }),
    ...(context.userAgent === null ? {} : { userAgent: context.userAgent }),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Sorts a failed WorkOS call into "it said no" and "it could not be asked".
 *
 * Read from the error's `status`, not its class: the SDK's exception classes
 * are module-local, and an `instanceof` against a second copy of the package
 * would quietly fall through to the wrong branch.
 *
 * The categories are for logs and metrics only — a wave of `invalid_grant` is
 * people double-clicking, a wave of `misconfigured` is a rotated key — and the
 * caller tells a person only that sign-in failed or is unavailable.
 */
export function providerFailure(cause: unknown): Error {
  if (cause instanceof IdentityVerificationError) return cause;

  const status = readNumber(cause, 'status');
  if (status === 401 || status === 403)
    return new IdentityProviderUnavailableError('misconfigured');
  if (status === 429) return new IdentityProviderUnavailableError('rate-limited');
  if (status === undefined || status >= 500) {
    return new IdentityProviderUnavailableError('unreachable');
  }

  // An authentication method switched off in the WorkOS dashboard — Magic Auth,
  // most likely, which the vault reset needs. That is a deployment fault: every
  // attempt fails the same way until somebody turns it on, and telling the
  // person to "sign in again" would send them round a loop with no exit.
  if (readString(cause, 'error') === 'authentication_method_not_allowed') {
    return new IdentityProviderUnavailableError('misconfigured');
  }

  // A 4xx about the request: an expired or replayed code (`invalid_grant`), a
  // wrong verifier, a Magic Auth code that does not match. The provider's own
  // code names it, bounded and stripped to a log-safe token.
  const code = readString(cause, 'error') ?? readString(cause, 'code') ?? `http-${status}`;
  return new IdentityVerificationError(
    code.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'rejected',
  );
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/** The isolate's client, keyed by the credentials it was built with. */
let cachedClient: { key: string; api: WorkosApi } | undefined;

/**
 * Builds the provider from the request's bindings.
 *
 * The SDK client is constructed lazily and kept for the isolate: it holds no
 * per-request state, and building it is not free. Keyed on the credentials, so
 * an isolate can never answer with a client configured for different ones.
 *
 * A missing API key or client id is a `MissingBindingError`, which the route
 * wrapper turns into a 503 — this deployment cannot sign anybody in, and that
 * is an operator's problem rather than the person's at the door.
 */
export function workosProvider(env: Bindings): WorkosIdentityProvider {
  const apiKey = env.WORKOS_API_KEY;
  if (!apiKey) throw new MissingBindingError('WORKOS_API_KEY');
  const clientId = env.WORKOS_CLIENT_ID;
  if (!clientId) throw new MissingBindingError('WORKOS_CLIENT_ID');

  const cacheKey = `${clientId}\u0000${apiKey}`;
  if (cachedClient?.key !== cacheKey) {
    cachedClient = { key: cacheKey, api: new WorkOS(apiKey, { clientId }) };
  }

  return new WorkosIdentityProvider(cachedClient.api, {
    clientId,
    redirectUri: callbackUrl(env),
  });
}

/**
 * Where AuthKit sends the browser back to.
 *
 * Derived from `XECRET_PUBLIC_URL` rather than configured beside it, so the two
 * cannot drift — a mismatch would be a redirect AuthKit refuses, for a reason
 * nobody would think to look for in a second variable.
 */
export function callbackUrl(env: Bindings): string {
  return `${publicOrigin(env)}/api/auth/callback`;
}

/** Exists for tests. */
export function resetWorkosClientForTesting(): void {
  cachedClient = undefined;
}
