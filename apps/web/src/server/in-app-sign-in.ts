import { IdentityVerificationError } from '@xecret/core/auth';
import type { AuthorizationCodeExchange, WorkosIdentity } from '@xecret/core/auth';
import { toBase64Url, utf8Encode } from '@xecret/core/crypto';
import { safePostSignInPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { SIGN_IN_ERROR_MESSAGES, SIGN_IN_FORM_MESSAGES } from '@/lib/sign-in-errors';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { ApiError, errors } from './errors';
import type { ApiErrorCode } from './errors';
import { isSameOriginPost, json, parseCookies } from './http';
import { attemptKey, consume, rateLimitKey } from './rate-limit';
import { SignInRefusal } from './sign-in';
import { completeSignIn } from './sign-in-completion';
import { SIGN_IN_CONFIRM_PATH } from './sign-in-confirmation';
import { classifySignInFailure, UNUSABLE_ANSWERS } from './sign-in-responses';
import { AuthenticationStepRequired } from './workos';
import type { WorkosIdentityProvider } from './workos';

/**
 * Signing in on xecret's own page — the server half.
 *
 * The sign-in and sign-up pages take a password, or an emailed six-digit code,
 * themselves, and post it here; these routes check it with WorkOS's headless
 * User Management API (`WorkosIdentityProvider.signInWithPassword` and
 * friends) and never send the browser to a WorkOS page. "Continue with Google"
 * is the one sign-in that leaves the site, and it goes through the login route
 * straight to Google and back to the callback.
 *
 * ── Four routes, one tail ──
 *  - `POST /api/auth/sign-in/password` — email and password.
 *  - `POST /api/auth/sign-in/code` — has WorkOS email a code (Magic Auth). The
 *    same for an address with an account and one without: WorkOS creates the
 *    account's WorkOS user when the address has none, which is how signing up
 *    works here, and the answer never says which it was.
 *  - `POST /api/auth/sign-in/code/verify` — the emailed code.
 *  - `POST /api/auth/sign-in/verify-email` — the code WorkOS emails when a
 *    password sign-in reaches an address it has not verified
 *    (`email_verification_required`); the password route hands the page the
 *    pending token that this one finishes with.
 *
 * Each ends in {@link finishInAppSignIn}: the exchange its WorkOS call minted
 * goes through `completeSignIn` — `prepareSignIn`, the confirmation question,
 * `issueSignIn` — exactly the code the callback runs. So impersonation, the
 * verified-address gate, an SSO sign-in's domains, the linker's conflict and
 * deleted-account refusals, `sso_required`, the per-identity rate limit and the
 * session itself are the same on every path, and are tested once per path.
 *
 * ── In front of WorkOS, in this order ──
 *  1. **Same origin, failing closed** ({@link guardInAppSignIn}): `Origin` must
 *     be this deployment's and `Sec-Fetch-Site`, if sent, `same-origin`; and
 *     the body must be `application/json`, which no cross-site form can send
 *     without a preflight this site never answers. Login CSRF — another site
 *     posting its owner's password from a victim's browser — stops here,
 *     before anything is spent.
 *  2. **The address bucket** — `RL_LOGIN`, the same key the callback spends.
 *  3. The body, parsed.
 *  4. **A per-subject bucket**, before WorkOS is asked: the address and the
 *     caller's IP for a password (the guessing surface `attemptKey` was made
 *     for); the address alone for a code request (mail to somebody's inbox,
 *     which an IP has no business multiplying) and for a code guess (a
 *     six-digit secret worth bounding however many addresses guess at it);
 *     the pending token for an email-verification guess. `prepareSignIn` then
 *     spends the per-identity bucket, keyed on the WorkOS user, as it does for
 *     the callback.
 *
 * ── How they answer ──
 * JSON, to the page's own `fetch`:
 *  - `{ redirect }` and the session cookies — or, for a sign-in held back for
 *    confirmation, `{ redirect: '/sign-in/confirm' }` and the sealed cookie;
 *    the page then loads that document;
 *  - `{ step: 'verify-email', pendingToken }` from the password route;
 *  - the API's error envelope otherwise, its message the same sentence
 *    `/sign-in?error=` shows ({@link inAppSignInFailure}) — or, for a wrong
 *    password or code, the sentence beside that field.
 *
 * ── Never logged, never echoed ──
 * The password and the codes are read from the body, handed to one WorkOS
 * call, and dropped. No log line, error message or response carries them;
 * validation errors name the rule, never the value (`parseWith`).
 */

/** When the request arrived, in seconds — the in-app sign-in's "flow began". */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** The request facts WorkOS takes for its own risk checks. */
export function requestContext(services: ServiceContext): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return { ipAddress: services.meta.ipAddress, userAgent: services.meta.userAgent };
}

/**
 * Steps 1 and 2 above. Throws a `csrf_failed` {@link ApiError} for a request
 * that is not this site's own page posting JSON, and a `rate-limited` refusal
 * when the address bucket is spent.
 */
export async function guardInAppSignIn(services: ServiceContext, request: Request): Promise<void> {
  if (!isSameOriginPost(request, publicOrigin(services.env))) {
    throw errors.csrf('in-app sign-in not posted from this origin');
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw errors.csrf('in-app sign-in not posted as JSON');
  }
  await spend(services, attemptKey(services.meta.ipAddress, null), 'per-address limit');
}

/** Spends one unit of `RL_LOGIN` under `key`, or refuses as rate-limited. */
export async function spend(services: ServiceContext, key: string, detail: string): Promise<void> {
  const decision = await consume(services.env, 'RL_LOGIN', key);
  if (!decision.allowed) throw new SignInRefusal('rate-limited', 429, detail);
}

/** The per-subject key for a password attempt: this address, from this IP. */
export function passwordAttemptKey(services: ServiceContext, email: string): string {
  return attemptKey(services.meta.ipAddress, email);
}

/** The per-subject key for an emailed code: the address alone, lower-cased. */
export function codeKey(purpose: 'send' | 'guess', email: string): string {
  return rateLimitKey([
    purpose === 'send' ? 'sign_in_code' : 'sign_in_code_guess',
    email.toLowerCase(),
  ]);
}

/**
 * The per-subject key for an email-verification guess: the pending token,
 * hashed — it names one paused authentication of one user, and a rate-limit key
 * is no place for a credential, even half of one.
 */
export async function verificationKey(pendingToken: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(pendingToken)));
  return rateLimitKey(['sign_in_verify_email', toBase64Url(digest).slice(0, 32)]);
}

/**
 * The shared tail, as JSON: the exchange through `completeSignIn`, and the
 * page told where to go — `next` (held to `safePostSignInPath` here, at the
 * moment of use) with the session cookies, or the confirmation with its sealed
 * cookie.
 */
export async function finishInAppSignIn(
  services: ServiceContext,
  request: Request,
  params: {
    exchange: AuthorizationCodeExchange<WorkosIdentity>;
    provider: Pick<WorkosIdentityProvider, 'verifiedDomains' | 'clientId'>;
    next: string | undefined;
  },
): Promise<Response> {
  const next = safePostSignInPath(params.next ?? null, POST_SIGN_IN_PATH);
  const done = await completeSignIn(services, {
    exchange: params.exchange,
    // Only ever an ordinary sign-in: the vault reset's re-authentication
    // still goes through the login route (`reauth=1`), whose state seals the
    // purpose; nothing here can ask for one.
    purpose: 'sign-in',
    provider: params.provider,
    flow: { organizationId: null, issuedAt: now() },
    next,
    cookies: parseCookies(request.headers.get('cookie')),
  });
  return done.kind === 'parked'
    ? json({ redirect: SIGN_IN_CONFIRM_PATH }, { cookies: [done.cookie] })
    : json({ redirect: next }, { cookies: done.cookies });
}

/** Which field a refused credential belongs to, for the sentence beside it. */
export type CredentialField = 'password' | 'code';

/**
 * Any failure of an in-app sign-in, as the JSON the page's form shows.
 *
 *  - The request's own faults (`csrf_failed`, `validation_failed`) pass
 *    through as the API answers them anywhere.
 *  - **WorkOS refused the credential** — a wrong password, an address with no
 *    account (the same answer), a wrong or expired code: a 400 with the
 *    sentence beside the field, from `SIGN_IN_FORM_MESSAGES`. Logged at `warn`
 *    with WorkOS's own reason, which is a bounded log-safe token.
 *  - Everything else is {@link classifySignInFailure}'s judgement — the
 *    callback's — answered with its status and the `/sign-in?error=` sentence
 *    for its code. A refusal from the linker (`account-conflict`,
 *    `account-deleted`), `verify-email`, `sso-required`, `impersonation`, a
 *    WorkOS step this page does not take, rate limits, an outage: one table.
 */
export function inAppSignInFailure(
  services: ServiceContext,
  cause: unknown,
  credential: CredentialField | null,
): Response {
  const requestId = services.meta.requestId;

  if (cause instanceof ApiError) {
    services.bindLog({ signInOutcome: 'refused', signInRefusal: cause.code });
    return json(cause.toBody(requestId), { status: cause.status });
  }

  if (
    credential !== null &&
    cause instanceof IdentityVerificationError &&
    !(cause instanceof AuthenticationStepRequired) &&
    !UNUSABLE_ANSWERS.has(cause.reason)
  ) {
    const message =
      credential === 'password'
        ? SIGN_IN_FORM_MESSAGES['wrong-password']
        : SIGN_IN_FORM_MESSAGES['wrong-code'];
    services.log
      .at('signIn')
      .warn(`Refused an in-app sign-in: WorkOS did not accept the ${credential}`, {
        reason: cause.reason,
        status: 400,
      });
    services.bindLog({ signInOutcome: 'refused', signInRefusal: `wrong-${credential}` });
    const error = new ApiError('bad_request', message, {
      fields: [{ field: credential, message }],
    });
    return json(error.toBody(requestId), { status: 400 });
  }

  const { code, status } = classifySignInFailure(services, cause);
  const error = new ApiError(apiCodeFor(status), SIGN_IN_ERROR_MESSAGES[code]);
  return json(error.toBody(requestId), { status });
}

/** The API's vocabulary for a refusal's status, so a generic client reads it right. */
function apiCodeFor(status: number): ApiErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'internal_error';
  if (status === 409) return 'conflict';
  if (status === 400) return 'bad_request';
  return 'forbidden';
}
