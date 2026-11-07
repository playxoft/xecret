import { GenerateLinkIntent, WorkOS } from '@workos-inc/node';
import {
  IdentityVerificationError,
  WORKOS_SESSION_ID_PATTERN,
  workosIdentity,
} from '@xecret/core/auth';
import { fromBase64Url } from '@xecret/core/crypto';
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
 * WorkOS authenticates a person; xecret decides what that person may do. An
 * authorization code — from Google, an organisation's single sign-on, or
 * AuthKit's hosted page — is exchanged **exactly once**, in the sign-in
 * callback, for the WorkOS user it names; a password or an emailed code typed
 * on xecret's own sign-in page is checked by one headless authenticate call
 * (`server/in-app-sign-in.ts`). Either way the access and refresh tokens that
 * come back are dropped on the floor. From there the credential is an xecret
 * session, which can be listed and revoked instantly. ADR 0010 has the
 * reasoning; it is ADR 0003's, with the provider swapped.
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
 * Nothing verifies a token, because nothing trusts one a client presented.
 * Every fact about a person comes back from an authenticated API call this
 * server made with its own secret key — the code exchange, the Magic Auth
 * check — so there is no signature for a client to forge and no audience for
 * one to get wrong. The one token read at all is the access token in the code
 * exchange's own response, for two claims: `auth_time` (see
 * {@link lastActiveAuthentication}) and `sid`, the AuthKit session, so that
 * signing out of xecret can end it too ({@link authKitSessionId}). It arrived
 * over the same authenticated call as the user it describes, so it is believed
 * exactly as far as that user is, and is otherwise dropped like the rest.
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
    | 'getAuthorizationUrl'
    | 'authenticateWithCode'
    | 'authenticateWithPassword'
    | 'authenticateWithEmailVerification'
    | 'authenticateWithOrganizationSelection'
    | 'createMagicAuth'
    | 'authenticateWithMagicAuth'
    | 'authenticateWithTotp'
    | 'getLogoutUrl'
  >;
  multiFactorAuth: Pick<WorkOS['multiFactorAuth'], 'challengeFactor'>;
  organizations: Pick<
    WorkOS['organizations'],
    'getOrganization' | 'getOrganizationByExternalId' | 'createOrganization' | 'deleteOrganization'
  >;
  adminPortal: Pick<WorkOS['adminPortal'], 'generateLink'>;
  sso: Pick<WorkOS['sso'], 'listConnections'>;
}

/** One of a WorkOS organisation's identity-provider connections, as the settings show it. */
export interface SsoConnectionSummary {
  id: string;
  /** WorkOS's connection type, e.g. `OktaSAML`, `GoogleSAML`, `GenericOIDC`. */
  type: string;
  /** `active` is the only state that can sign anybody in. */
  state: 'draft' | 'active' | 'inactive' | 'validating';
}

/** One of a WorkOS organisation's domains, and how far its verification has got. */
export interface SsoDomainSummary {
  domain: string;
  state: 'verified' | 'pending' | 'failed';
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
  /**
   * Read only for its `auth_time` and `sid` claims; never stored, logged or
   * passed on itself.
   */
  accessToken?: string | undefined;
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
 * The longest password forwarded to WorkOS. Far beyond any passphrase a person
 * types or a manager generates; the bound exists so that a hostile body is
 * refused on shape rather than forwarded.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/** The longest address forwarded to WorkOS — the standard's own ceiling. */
export const MAX_EMAIL_LENGTH = 320;

/**
 * The longest pending-authentication token accepted back from a browser. WorkOS
 * hands these out with an `email_verification_required` answer; they are opaque
 * and short, and anything far longer is not one.
 */
export const MAX_PENDING_TOKEN_LENGTH = 2048;

/** Printable ASCII without spaces: what an opaque WorkOS token can be made of. */
const PENDING_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

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

/**
 * WorkOS's authentication-error codes: answers that are neither "yes" nor "no"
 * but "one more step first". The SDK raises them as `AuthenticationException`
 * with this `code` (and, for `sso_required`, an OAuth-style `error`).
 */
export const AUTHENTICATION_STEP_CODES = [
  'mfa_challenge',
  'mfa_enrollment',
  'mfa_verification',
  'organization_selection_required',
  'email_verification_required',
  'sso_required',
  'radar_email_challenge',
  'radar_sms_challenge',
  'organization_authentication_methods_required',
] as const;

export type AuthenticationStepCode = (typeof AUTHENTICATION_STEP_CODES)[number];

/**
 * WorkOS accepted the credential and wants another step before it will say
 * whose it is — most often the user's authenticator (`mfa_challenge`).
 *
 * A verification failure in the eyes of anything that does not handle it — the
 * sign-in callback treats it as one — but its own class, because the vault
 * reset's emailed-code step can complete one of these (the TOTP) and must give
 * a specific answer for the rest, rather than calling a right code wrong or a
 * WorkOS policy an outage. Branching on the code comes *before* branching on
 * the HTTP status, which differs between these answers and says nothing useful.
 */
export class AuthenticationStepRequired extends IdentityVerificationError {
  constructor(
    readonly code: AuthenticationStepCode,
    /** Present for `mfa_challenge` and the other resumable steps. */
    readonly pendingAuthenticationToken: string | null,
    /** The user's TOTP factor, for `mfa_challenge`. */
    readonly totpFactorId: string | null,
    /**
     * For `organization_selection_required`: the WorkOS organisations the user
     * may continue into, in the order WorkOS listed them. Ids only — the names
     * WorkOS sends beside them are never read.
     */
    readonly organizationIds: readonly string[] = [],
  ) {
    super(code);
    this.name = 'AuthenticationStepRequired';
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
    /**
     * Go straight to one OAuth provider — `GoogleOAuth`, the in-app sign-in
     * page's "Continue with Google" — instead of AuthKit's hosted page. WorkOS
     * redirects to Google itself and back to the callback; the person never
     * sees a WorkOS screen. Ignored beside `organizationId`, which wins.
     */
    provider?: 'GoogleOAuth' | undefined;
    /** For AuthKit's hosted page only; meaningless beside a provider. */
    screenHint?: 'sign-up' | 'sign-in' | undefined;
    /**
     * Ask the provider to make the person authenticate again even if it holds a
     * session for them. `0` is the only value this application uses: see the
     * reauth purpose in `server/sign-in.ts`.
     */
    maxAge?: number | undefined;
  }): string {
    const viaAuthKit = params.organizationId === undefined && params.provider === undefined;
    return this.#api.userManagement.getAuthorizationUrl({
      // An SSO deep link names the organisation instead of the provider:
      // WorkOS takes exactly one of the two.
      ...(params.organizationId !== undefined
        ? { organizationId: params.organizationId }
        : { provider: params.provider ?? 'authkit' }),
      clientId: this.#config.clientId,
      redirectUri: this.#config.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      ...(params.screenHint === undefined || !viaAuthKit ? {} : { screenHint: params.screenHint }),
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

    return this.#authenticate(
      () =>
        this.#api.userManagement.authenticateWithCode({
          clientId: this.#config.clientId,
          code,
          codeVerifier: context.codeVerifier,
          ...requestFacts(context),
        }),
      context,
      { credential: false },
    );
  }

  /**
   * Signs a person in with the email and password they typed on xecret's own
   * sign-in page — WorkOS's headless password authentication, the same
   * identity a code exchange would have produced, minted the same way.
   *
   * The password is forwarded once, over this authenticated call, and kept
   * nowhere: not in a variable that outlives the call, not in an error, not in
   * a log. A wrong one, or an address with no account, is the same
   * `IdentityVerificationError` — WorkOS does not tell them apart, and neither
   * does anything above this.
   *
   * WorkOS can answer "one more step" instead of a user: most often
   * `email_verification_required`, for an address it has not verified, which
   * reaches the caller as an {@link AuthenticationStepRequired} carrying the
   * pending token that {@link completeEmailVerification} finishes with.
   */
  async signInWithPassword(
    params: { email: string; password: string },
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
    assertEmailShape(params.email);
    if (
      typeof params.password !== 'string' ||
      params.password === '' ||
      params.password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new IdentityVerificationError('malformed-password');
    }

    return this.#authenticate(
      () =>
        this.#api.userManagement.authenticateWithPassword({
          clientId: this.#config.clientId,
          email: params.email,
          password: params.password,
          ...requestFacts(context),
        }),
      context,
      { credential: true },
    );
  }

  /**
   * Signs a person in with the six-digit code WorkOS emailed them
   * ({@link createMagicAuth}) — the in-app page's "email me a code", which is
   * also how an account is created there. Unlike
   * {@link authenticateWithMagicAuth}, which only says whose inbox a code
   * reached (the vault reset's second lock), this answers the whole exchange,
   * for the sign-in to be built on.
   */
  async signInWithMagicAuth(
    params: { email: string; code: string },
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
    assertEmailShape(params.email);
    assertCodeShape(params.code, MAGIC_AUTH_CODE_PATTERN);

    return this.#authenticate(
      () =>
        this.#api.userManagement.authenticateWithMagicAuth({
          clientId: this.#config.clientId,
          code: params.code,
          email: params.email,
          ...requestFacts(context),
        }),
      context,
      { credential: true },
    );
  }

  /**
   * Finishes a sign-in WorkOS paused with `email_verification_required`: the
   * code WorkOS emailed to the address, with the pending token from the paused
   * answer. A right code verifies the address at WorkOS and authenticates in
   * one call, and the user it answers is verified — which is what lets the
   * sign-in past `prepareSignIn`'s step 2.
   */
  async completeEmailVerification(
    params: { code: string; pendingAuthenticationToken: string },
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
    assertCodeShape(params.code, MAGIC_AUTH_CODE_PATTERN);
    assertPendingTokenShape(params.pendingAuthenticationToken);

    return this.#authenticate(
      () =>
        this.#api.userManagement.authenticateWithEmailVerification({
          clientId: this.#config.clientId,
          code: params.code,
          pendingAuthenticationToken: params.pendingAuthenticationToken,
          ...requestFacts(context),
        }),
      context,
      { credential: true },
    );
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
   * Finishes an authentication WorkOS paused with `mfa_challenge`: challenges
   * the user's TOTP factor and presents their authenticator code with the
   * pending-authentication token. Says which WorkOS user that proved, and
   * whether anybody was impersonating them — the same answer as
   * {@link authenticateWithMagicAuth}, one step later.
   */
  async completeWithTotp(
    params: { code: string; pendingAuthenticationToken: string; totpFactorId: string },
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<{ workosUserId: string; impersonated: boolean }> {
    assertCodeShape(params.code, MAGIC_AUTH_CODE_PATTERN);

    let response: WorkosAuthentication;
    try {
      const challenge = await this.#api.multiFactorAuth.challengeFactor({
        authenticationFactorId: params.totpFactorId,
      });
      response = await this.#api.userManagement.authenticateWithTotp({
        clientId: this.#config.clientId,
        code: params.code,
        pendingAuthenticationToken: params.pendingAuthenticationToken,
        authenticationChallengeId: challenge.id,
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
    const domains = await this.domains(workosOrgId);
    return new Set(
      domains.filter((entry) => entry.state === 'verified').map((entry) => entry.domain),
    );
  }

  /**
   * Every domain a WorkOS organisation has, lower-cased, with its verification
   * state — for the SSO settings' status display, and beneath
   * {@link verifiedDomains}. A state WorkOS adds later reads as `pending`:
   * not verified, which is the only distinction anything here acts on.
   */
  async domains(workosOrgId: string): Promise<SsoDomainSummary[]> {
    try {
      const organization = await this.#api.organizations.getOrganization(workosOrgId);
      return organization.domains.map((entry) => ({
        domain: entry.domain.toLowerCase(),
        state:
          entry.state === 'verified' ? 'verified' : entry.state === 'failed' ? 'failed' : 'pending',
      }));
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /**
   * Creates the WorkOS organisation an xecret organisation's SSO hangs off,
   * and answers its id.
   *
   * ── Never with domains, and never with domains marked verified ──
   * The payload is built here, field by field, from a name and the xecret
   * organisation's id, and it has no `domainData` — the parameter type has no
   * room for one, and nothing from the caller is spread into the request. That
   * is PR #114's constraint, and the reason is the sign-in callback's step 3:
   * an SSO sign-in is believed only for the domains WorkOS reports as
   * *verified*. WorkOS accepts `domainData` entries already in the `verified`
   * state from whoever holds the API key, so a domain xecret declared verified
   * would let that organisation's identity provider assert any address in it —
   * anybody's account at that company, adopted by the linker. Domains are added
   * and verified through WorkOS's own flow (the Admin Portal, by DNS) and
   * nowhere else.
   *
   * ── Idempotent ──
   * Keyed for WorkOS's idempotency by the xecret organisation, so two "enable"
   * requests racing each other get one WorkOS organisation rather than one each.
   * Past WorkOS's idempotency window, a retry that finds the `externalId`
   * already taken (409) adopts the organisation holding it: only this
   * deployment's secret key can create organisations in this WorkOS
   * environment, and it gives each the id of the xecret organisation it is for,
   * so one already carrying that id was made for this one — by an earlier
   * attempt whose database write never landed.
   */
  async createOrganization(params: { name: string; externalId: string }): Promise<string> {
    const payload = { name: params.name, externalId: params.externalId };
    try {
      const created = await this.#api.organizations.createOrganization(payload, {
        idempotencyKey: `xecret-sso-enable-${params.externalId}`,
      });
      return created.id;
    } catch (cause) {
      if (readNumber(cause, 'status') !== 409) throw providerFailure(cause);
    }

    try {
      const existing = await this.#api.organizations.getOrganizationByExternalId(params.externalId);
      if (existing.externalId !== params.externalId) {
        throw new IdentityVerificationError('external-id-mismatch');
      }
      return existing.id;
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /**
   * Deletes a WorkOS organisation — only ever one this request created and then
   * could not link, because another request linked a different one first
   * (PR #100, note 7). An orphan left at WorkOS is harmless to sign-in, since
   * nothing here resolves to it, but it is a tenant nobody owns.
   */
  async deleteOrganization(workosOrgId: string): Promise<void> {
    try {
      await this.#api.organizations.deleteOrganization(workosOrgId);
    } catch (cause) {
      throw providerFailure(cause);
    }
  }

  /**
   * An Admin Portal link for the organisation's IT admin to connect its
   * identity provider — Okta, Entra ID, Google Workspace, any SAML or OIDC
   * provider. Short-lived, and as good as a credential while it lasts: whoever
   * opens it decides which identity provider vouches for this organisation's
   * members. It is handed to the caller and never logged or stored.
   */
  async generatePortalLink(params: { workosOrgId: string; returnUrl: string }): Promise<string> {
    let link: string;
    try {
      ({ link } = await this.#api.adminPortal.generateLink({
        organization: params.workosOrgId,
        intent: GenerateLinkIntent.SSO,
        returnUrl: params.returnUrl,
      }));
    } catch (cause) {
      throw providerFailure(cause);
    }
    // The dashboard opens whatever this is, so it must be a page on the web:
    // never a `javascript:` URL, a relative path, or nothing at all.
    if (!URL.canParse(link) || new URL(link).protocol !== 'https:') {
      throw new IdentityVerificationError('portal-link-not-https');
    }
    return link;
  }

  /**
   * The organisation's SSO connections, for the settings' status display and
   * for the check that `sso_required` has an active connection to require.
   * Copied field by field: nothing else WorkOS says about a connection leaves
   * this file.
   *
   * ── Every page, up to a cap ──
   * WorkOS lists ten to a page unless asked otherwise, and the first page alone
   * would let an organisation with an eleventh connection — the only active
   * one, say — read as having none. So this asks for the largest page WorkOS
   * serves ({@link CONNECTION_PAGE_SIZE}) and follows the cursor, for at most
   * {@link CONNECTION_PAGE_LIMIT} pages: an organisation has a handful of
   * connections, and a cursor that never ends is not a reason for one settings
   * read to spend a Worker's subrequests. Past the cap the list is what was
   * read, which can only under-report connections — never invent an active one.
   *
   * ── A state WorkOS adds later ──
   * Reads as `inactive`, as an unknown domain state reads as `pending`: not
   * active, which is the only distinction anything here acts on — and a value
   * the dashboard has no label for would otherwise fail its render.
   */
  async listConnections(workosOrgId: string): Promise<SsoConnectionSummary[]> {
    const connections: SsoConnectionSummary[] = [];
    let after: string | undefined;
    try {
      for (let page = 0; page < CONNECTION_PAGE_LIMIT; page += 1) {
        const listed = await this.#api.sso.listConnections({
          organizationId: workosOrgId,
          limit: CONNECTION_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        });
        for (const { id, state, type } of listed.data) {
          connections.push({ id, state: connectionState(state), type: String(type) });
        }
        const next = listed.listMetadata?.after;
        if (typeof next !== 'string' || next === '' || next === after) break;
        after = next;
      }
    } catch (cause) {
      throw providerFailure(cause);
    }
    return connections;
  }

  /**
   * WorkOS's logout URL for one AuthKit session: the browser follows it, WorkOS
   * ends that session on its hosted domain, and sends the browser back to
   * `returnTo` (review round 2). Built locally by the SDK — no call is made —
   * from a session id this server read out of its own code exchange, never one
   * a client named.
   *
   * `returnTo` must be one of the environment's configured logout redirects in
   * the WorkOS dashboard. What WorkOS does with any other — fall back to its
   * default, or show an error page — is to be verified live, not assumed
   * (`docs/operations/workos-environments.md` §4), which is why the redirect is
   * configured before this is deployed.
   */
  logoutUrl(params: { sessionId: string; returnTo: string }): string {
    if (!WORKOS_SESSION_ID_PATTERN.test(params.sessionId)) {
      throw new IdentityVerificationError('malformed-session-id');
    }
    const url = this.#api.userManagement.getLogoutUrl({
      sessionId: params.sessionId,
      returnTo: params.returnTo,
    });
    // The browser is sent wherever this is, so it must be a page on the web.
    if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
      throw new IdentityVerificationError('logout-url-not-https');
    }
    return url;
  }

  /**
   * This deployment's WorkOS client id — which WorkOS *environment* it talks
   * to. Recorded beside an organisation's `workos_org_id` when SSO is turned on
   * and compared on every settings call (review S9), because an organisation id
   * means something only in the environment that made it.
   */
  get clientId(): string {
    return this.#config.clientId;
  }

  /**
   * One authenticate call, its failure sorted ({@link providerFailure}), and
   * its answer minted into an exchange — the path every way of signing in
   * shares, so a password, an emailed code and an authorization code all reach
   * `prepareSignIn` as the same object, minted in the same place.
   *
   * ── Organisation selection ──
   * WorkOS answers `organization_selection_required` for a user who belongs to
   * more than one *WorkOS* organisation — which a person does once they have
   * signed in through more than one organisation's single sign-on. AuthKit's
   * hosted page asks the person to pick; nothing here does, because nothing
   * here reads the choice: xecret decides its own organisations, and the
   * organisation of a sign-in that was not single sign-on is ignored by every
   * step that grants anything (`signInFactsOf` keys on `SSO` *and* the
   * organisation). So the first organisation WorkOS listed is selected and the
   * authentication finished. Its answer names that organisation, which the
   * sign-in did not ask for — so the sign-in is held back for the person to
   * confirm, exactly as it was when AuthKit asked them to pick.
   */
  async #authenticate(
    call: () => Promise<WorkosAuthentication>,
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
    options: { credential: boolean },
  ): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
    let response: WorkosAuthentication;
    try {
      response = await call();
    } catch (cause) {
      const failure = providerFailure(cause, options);
      if (
        !(failure instanceof AuthenticationStepRequired) ||
        failure.code !== 'organization_selection_required'
      ) {
        throw failure;
      }
      response = await this.#selectOrganization(failure, context);
    }
    return this.#toExchange(response);
  }

  async #selectOrganization(
    step: AuthenticationStepRequired,
    context: Omit<CodeExchangeContext, 'codeVerifier'>,
  ): Promise<WorkosAuthentication> {
    const organizationId = step.organizationIds[0];
    if (step.pendingAuthenticationToken === null || organizationId === undefined) throw step;
    try {
      return await this.#api.userManagement.authenticateWithOrganizationSelection({
        clientId: this.#config.clientId,
        pendingAuthenticationToken: step.pendingAuthenticationToken,
        organizationId,
        ...requestFacts(context),
      });
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
      authenticatedAt: lastActiveAuthentication(response.accessToken),
      providerSessionId: authKitSessionId(response.accessToken),
      impersonator:
        response.impersonator === undefined ? null : { email: response.impersonator.email },
    };
  }
}

/** The largest page WorkOS's list endpoints serve. */
export const CONNECTION_PAGE_SIZE = 100;

/** How many pages of connections one read follows — 500 connections, at most. */
export const CONNECTION_PAGE_LIMIT = 5;

const CONNECTION_STATES: ReadonlySet<string> = new Set([
  'draft',
  'active',
  'inactive',
  'validating',
]);

/** A connection state as the settings know them; anything else is not active. */
function connectionState(state: unknown): SsoConnectionSummary['state'] {
  return typeof state === 'string' && CONNECTION_STATES.has(state)
    ? (state as SsoConnectionSummary['state'])
    : 'inactive';
}

/** Longer than any access token WorkOS issues; anything bigger is not read. */
const MAX_ACCESS_TOKEN_LENGTH = 8192;

/**
 * The `auth_time` claim of an access token WorkOS returned — "the user's most
 * recent active authentication", which WorkOS documents as advancing only when
 * the person actually authenticates, never on a refresh or a reused session —
 * or `null` when there is none to read.
 *
 * Decoded, not verified, and that is deliberate: the token is not something a
 * browser presented. It came back in the body of the code exchange this server
 * made to WorkOS with its own secret key, beside the `user` the sign-in is
 * built on, so it is exactly as trustworthy as that user — and a forger able to
 * change it could change the user instead. Anything malformed reads as `null`,
 * which the vault reset's first lock treats as "not shown to be fresh".
 *
 * Checked live against WorkOS Staging (2026-10-14): a password sign-in's token
 * carries `auth_time` equal to the sign-in; a refresh keeps it; a second
 * sign-in moves it.
 */
export function lastActiveAuthentication(accessToken: unknown): number | null {
  const authTime = accessTokenClaims(accessToken)?.['auth_time'];
  return typeof authTime === 'number' && Number.isSafeInteger(authTime) && authTime > 0
    ? authTime
    : null;
}

/**
 * The `sid` claim of the same access token — the AuthKit session this sign-in
 * came from — or `null` when there is none to read, or it is not shaped like a
 * WorkOS session id (review round 2). Kept on the xecret session so sign-out
 * can end the AuthKit session too. Decoded, not verified, for the reason
 * {@link lastActiveAuthentication} gives; and a session id names a session,
 * it does not authenticate as one.
 */
export function authKitSessionId(accessToken: unknown): string | null {
  const sid = accessTokenClaims(accessToken)?.['sid'];
  return typeof sid === 'string' && WORKOS_SESSION_ID_PATTERN.test(sid) ? sid : null;
}

/** The claims of an access token from the code exchange's own response, or `null`. */
function accessTokenClaims(accessToken: unknown): Record<string, unknown> | null {
  if (typeof accessToken !== 'string' || accessToken.length > MAX_ACCESS_TOKEN_LENGTH) return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(parts[1])));
  } catch {
    return null;
  }
  return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : null;
}

function assertCodeShape(code: string, pattern: RegExp): void {
  // A structural check before any work: WorkOS will refuse this anyway, but
  // not before an attacker-chosen string has been forwarded to it.
  if (typeof code !== 'string' || code === '' || code.length > MAX_CODE_LENGTH) {
    throw new IdentityVerificationError('malformed-code');
  }
  if (!pattern.test(code)) throw new IdentityVerificationError('malformed-code');
}

/** An address on shape alone — an `@` with something either side, bounded. */
function assertEmailShape(email: string): void {
  if (
    typeof email !== 'string' ||
    email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  ) {
    throw new IdentityVerificationError('malformed-email');
  }
}

function assertPendingTokenShape(token: string): void {
  if (
    typeof token !== 'string' ||
    token.length > MAX_PENDING_TOKEN_LENGTH ||
    !PENDING_TOKEN_PATTERN.test(token)
  ) {
    throw new IdentityVerificationError('malformed-pending-token');
  }
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
 *
 * ── `credential` ──
 * For the calls that check something a person typed — a password, an emailed
 * code. WorkOS answers its authenticate endpoint's refusals with 400 *or* 403
 * (the step answers show both), and a 403 there that names its reason —
 * `invalid_credentials`, a wrong or expired code — is the person's mistake,
 * not this deployment's key. Without a reason it is still read as the key: a
 * refused API key is what a bare 401 or 403 means everywhere else, and the SDK
 * strips every 401 of its body, so a 401 is never read as a wrong password.
 */
export function providerFailure(cause: unknown, options: { credential?: boolean } = {}): Error {
  if (cause instanceof IdentityVerificationError) return cause;

  // WorkOS's "one more step" answers first, by their code: their HTTP status
  // varies (400 or 403) and would otherwise read as "wrong code" or as "our
  // key is misconfigured", neither of which is true.
  const step = authenticationStep(cause);
  if (step !== null) return step;

  // An authentication method switched off in the WorkOS dashboard — Magic Auth,
  // most likely, which the vault reset needs. That is a deployment fault: every
  // attempt fails the same way until somebody turns it on, and telling the
  // person to "sign in again" would send them round a loop with no exit. Read
  // from `error` (an OAuth-style answer) and from `code` alike.
  if (
    readString(cause, 'error') === 'authentication_method_not_allowed' ||
    readString(cause, 'code') === 'authentication_method_not_allowed'
  ) {
    return new IdentityProviderUnavailableError('misconfigured');
  }

  const status = readNumber(cause, 'status');
  const named = readString(cause, 'error') ?? readString(cause, 'code');
  if (options.credential === true && status === 403 && named !== undefined) {
    return new IdentityVerificationError(
      named.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'rejected',
    );
  }
  if (status === 401 || status === 403)
    return new IdentityProviderUnavailableError('misconfigured');
  if (status === 429) return new IdentityProviderUnavailableError('rate-limited');
  if (status === undefined || status >= 500) {
    return new IdentityProviderUnavailableError('unreachable');
  }

  // A 4xx about the request: an expired or replayed code (`invalid_grant`), a
  // wrong verifier, a Magic Auth code that does not match. The provider's own
  // code names it, bounded and stripped to a log-safe token.
  const code = readString(cause, 'error') ?? readString(cause, 'code') ?? `http-${status}`;
  return new IdentityVerificationError(
    code.replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'rejected',
  );
}

/** The step WorkOS asked for, from an `AuthenticationException`-shaped error, or `null`. */
function authenticationStep(cause: unknown): AuthenticationStepRequired | null {
  const raw = readRecord(cause, 'rawData');
  const named = readString(cause, 'code') ?? readString(cause, 'error');
  const code = AUTHENTICATION_STEP_CODES.find((known) => known === named);
  if (code === undefined) return null;

  const pending =
    readString(cause, 'pendingAuthenticationToken') ??
    (raw ? readString(raw, 'pending_authentication_token') : undefined) ??
    null;
  const factors = raw?.['authentication_factors'];
  const totp: unknown = Array.isArray(factors)
    ? factors.find(
        (factor: unknown) =>
          readString(factor, 'type') === 'totp' && readString(factor, 'id') !== undefined,
      )
    : undefined;
  const organizations = raw?.['organizations'];
  const organizationIds = Array.isArray(organizations)
    ? organizations
        .map((organization: unknown) => readString(organization, 'id'))
        .filter((id): id is string => id !== undefined)
    : [];
  return new AuthenticationStepRequired(
    code,
    pending,
    readString(totp, 'id') ?? null,
    organizationIds,
  );
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'object' && field !== null
    ? (field as Record<string, unknown>)
    : undefined;
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
