import {
  clearedEmailVerificationCookie,
  deriveEmailVerificationKey,
  EMAIL_VERIFICATION_COOKIE_NAME,
  emailVerificationCookie,
  IdentityVerificationError,
  isSameVerificationAddress,
  openEmailVerification,
  sealEmailVerification,
} from '@xecret/core/auth';
import type {
  AuthorizationCodeExchange,
  EmailVerification,
  WorkosIdentity,
} from '@xecret/core/auth';
import { safePostSignInPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { SIGN_IN_ERROR_MESSAGES, SIGN_IN_FORM_MESSAGES } from '@/lib/sign-in-errors';
import type { Bindings } from './bindings';
import { MissingBindingError, publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { ApiError, errors } from './errors';
import type { ApiErrorCode } from './errors';
import { isSameOriginPost, json, parseCookies } from './http';
import { attemptKey, consume, rateLimitKey } from './rate-limit';
import { SignInRefusal } from './sign-in';
import { completeSignIn } from './sign-in-completion';
import { SIGN_IN_CONFIRM_PATH } from './sign-in-confirmation';
import { classifySignInFailure, UNUSABLE_ANSWERS } from './sign-in-responses';
import { assertNotLockedOut, clearSignInFailuresFor, countSignInFailure } from './sign-in-throttle';
import { AuthenticationStepRequired } from './workos';
import type { AuthenticationStepCode, WorkosIdentityProvider } from './workos';

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
 *    (`email_verification_required`) — **off until proven safe**; see
 *    {@link emailVerificationStepEnabled}.
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
 *     without a preflight this site never answers. This is the **login-CSRF**
 *     defence — another site making a victim's *browser* post its owner's
 *     password, and leaving the victim signed in to the attacker's account —
 *     and nothing more: a script outside a browser sets `Origin` to whatever it
 *     likes, so it is no defence against a bot. The brakes on a bot are steps
 *     2, 4 and 5.
 *  2. **An address bucket** — `RL_LOGIN`, keyed on the caller's IP. The password
 *     and code routes spend the key the callback spends; asking for a code and
 *     verifying an address each have their own, so one sign-in's two steps do
 *     not spend one allowance twice.
 *  3. The body, parsed.
 *  4. **Per-subject buckets**, before WorkOS is asked: the address and the
 *     caller's IP for a guess (the guessing surface `attemptKey` was made for);
 *     the address alone for a code request (mail to somebody's inbox, which an
 *     IP has no business multiplying) and for a code guess (a six-digit secret
 *     worth bounding however many addresses guess at it).
 *  5. **The durable per-address lockout** (`server/sign-in-throttle.ts`,
 *     `sign_in_failures`): consecutive failures against the address, global
 *     and in the database, so rotating IPs and data centres buys nothing. A
 *     locked address is refused as rate-limited before WorkOS is asked; a
 *     refused credential counts; a success clears it. `prepareSignIn` then
 *     spends the per-identity bucket, keyed on the WorkOS user, as it does for
 *     the callback.
 *
 * ── Answers that must look alike ──
 * A wrong password and an address with no account are one WorkOS answer and
 * one sentence. So is everything WorkOS might decide *before* it has checked
 * the credential, when telling it apart would say something about the address:
 * `organization_authentication_methods_required` (the address belongs to an
 * organisation with an authentication policy) is answered as a wrong password
 * or code, and counted like one. Its domain-wide twin `sso_required` is not
 * folded: it says only that a domain signs in by single sign-on, which is the
 * one thing the person needs to hear and no more than AuthKit's page said.
 *
 * ── How they answer ──
 * JSON, to the page's own `fetch`:
 *  - `{ redirect }` and the session cookies — or, for a sign-in held back for
 *    confirmation, `{ redirect: '/sign-in/confirm' }` and the sealed cookie;
 *    the page then loads that document;
 *  - `{ step: 'verify-email' }` from the password route, only while the
 *    verification step is enabled, with its sealed cookie;
 *  - the API's error envelope otherwise, its message the same sentence
 *    `/sign-in?error=` shows ({@link inAppSignInFailure}) — or, for a refused
 *    credential, the sentence beside that field.
 *
 * ── Never logged, never echoed ──
 * The password and the codes are read from the body, handed to one WorkOS
 * call, and dropped. No log line, error message or response carries them;
 * validation errors name the rule, never the value (`parseWith`). WorkOS's
 * pending-authentication token never reaches the page at all: it travels in
 * the `HttpOnly`, `SameSite=Strict` verification cookie, sealed beside the
 * address it was minted for.
 */

/**
 * Whether a password sign-in that WorkOS answers `email_verification_required`
 * gets the emailed-code step (`true`), or the wrong-password answer (`false`,
 * the default).
 *
 * ── Why off ──
 * The answer is only safe to give if WorkOS checks the password *before* it
 * decides the address needs verifying. If it decides first — and this repo's
 * own migration runbook treats `email_verification_required` as something "in
 * front of the password check" — then a code step for any password would tell
 * anybody that the address has an unverified account, and have WorkOS email it
 * a code on demand. WorkOS's error does not say which order it used, so the
 * safe default is no oracle: the step is answered exactly like a wrong
 * password, and counted like one. The person's way in is "email me a code",
 * which verifies the address as it signs them in.
 *
 * **Staging check before turning this on:** with a WorkOS user whose address
 * is unverified, a *wrong* password must answer `invalid_credentials`, and only
 * the right one `email_verification_required`. If so, set this to `true` — the
 * route, the cookie and the page are built and tested for it.
 */
const EMAIL_VERIFICATION_STEP = false;
let emailVerificationStep = EMAIL_VERIFICATION_STEP;

/** See {@link EMAIL_VERIFICATION_STEP}. */
export function emailVerificationStepEnabled(): boolean {
  return emailVerificationStep;
}

/** Exists for tests. `null` restores the default. */
export function setEmailVerificationStepForTesting(enabled: boolean | null): void {
  emailVerificationStep = enabled ?? EMAIL_VERIFICATION_STEP;
}

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

/** Which route's address bucket a request spends — see step 2 above. */
export type AddressBucket = 'sign-in' | 'code-send' | 'verify-email';

function addressKey(services: ServiceContext, bucket: AddressBucket): string {
  const ip = services.meta.ipAddress;
  switch (bucket) {
    case 'sign-in':
      // The key the callback spends: a sign-in is a sign-in, however it came.
      return attemptKey(ip, null);
    case 'code-send':
      return rateLimitKey(['sign_in_code_send_ip', ip]);
    case 'verify-email':
      return rateLimitKey(['sign_in_verify_email_ip', ip]);
  }
}

/**
 * Steps 1 and 2 above. Throws a `csrf_failed` {@link ApiError} for a request
 * that is not this site's own page posting JSON, and a `rate-limited` refusal
 * when the address bucket is spent.
 */
export async function guardInAppSignIn(
  services: ServiceContext,
  request: Request,
  bucket: AddressBucket,
): Promise<void> {
  if (!isSameOriginPost(request, publicOrigin(services.env))) {
    throw errors.csrf('in-app sign-in not posted from this origin');
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw errors.csrf('in-app sign-in not posted as JSON');
  }
  await spend(services, addressKey(services, bucket), `per-address limit (${bucket})`);
}

/** Spends one unit of `RL_LOGIN` under `key`, or refuses as rate-limited. */
export async function spend(services: ServiceContext, key: string, detail: string): Promise<void> {
  const decision = await consume(services.env, 'RL_LOGIN', key);
  if (!decision.allowed) throw new SignInRefusal('rate-limited', 429, detail);
}

/** The per-subject key for a password or code guess: this address, from this IP. */
export function guessAttemptKey(services: ServiceContext, email: string): string {
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
 * WorkOS refused the credential the person typed — or answered in a way the
 * routes deliberately make look the same. Carries WorkOS's own reason, a
 * bounded log-safe token, for the log line and nothing else.
 */
export class RefusedCredential extends Error {
  constructor(readonly reason: string) {
    super('The credential was refused');
    this.name = 'RefusedCredential';
  }
}

/** The WorkOS steps answered as a refused credential on every in-app route. */
const FOLDED_STEPS: ReadonlySet<AuthenticationStepCode> = new Set([
  'organization_authentication_methods_required',
]);

/** Whether `cause` is WorkOS refusing the credential, as the routes treat it. */
function isRefusedCredential(cause: unknown, fold: ReadonlySet<AuthenticationStepCode>): boolean {
  if (cause instanceof AuthenticationStepRequired) return fold.has(cause.code);
  return cause instanceof IdentityVerificationError && !UNUSABLE_ANSWERS.has(cause.reason);
}

/**
 * Steps 5 and the WorkOS call, for one guess at a credential: refuses a locked
 * address, asks WorkOS, and keeps the address's count — cleared when WorkOS
 * accepts, one more when it refuses (or answers in a way folded into a refusal,
 * `fold`). Anything else WorkOS says passes through untouched, uncounted.
 */
export async function checkCredential(
  services: ServiceContext,
  subject: Uint8Array<ArrayBuffer>,
  attempt: () => Promise<AuthorizationCodeExchange<WorkosIdentity>>,
  fold: ReadonlySet<AuthenticationStepCode> = FOLDED_STEPS,
): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
  await assertNotLockedOut(services, subject);
  try {
    const exchange = await attempt();
    await clearSignInFailuresFor(services, subject);
    return exchange;
  } catch (cause) {
    if (!isRefusedCredential(cause, fold)) throw cause;
    await countSignInFailure(services, subject);
    throw new RefusedCredential(
      cause instanceof IdentityVerificationError ? cause.reason : 'refused',
    );
  }
}

/**
 * The steps a password sign-in folds into "wrong password": the shared ones,
 * and — while {@link emailVerificationStepEnabled} is off —
 * `email_verification_required` too.
 */
export function passwordFoldedSteps(): ReadonlySet<AuthenticationStepCode> {
  return emailVerificationStepEnabled()
    ? FOLDED_STEPS
    : new Set([...FOLDED_STEPS, 'email_verification_required']);
}

/**
 * Whether WorkOS declining to send a code is about the address — answered
 * with the same 204 as a code sent, so the answer says nothing about it.
 */
export function isFoldedAddressRefusal(cause: unknown): boolean {
  return (
    cause instanceof IdentityVerificationError &&
    (!(cause instanceof AuthenticationStepRequired) || FOLDED_STEPS.has(cause.code))
  );
}

/** The MAC key for the verification cookie, from the cookie secret. Same failure as the others. */
async function emailVerificationKey(env: Bindings): Promise<CryptoKey> {
  const secret = env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new MissingBindingError('WORKOS_COOKIE_PASSWORD');
  try {
    return await deriveEmailVerificationKey(secret);
  } catch {
    throw new MissingBindingError('WORKOS_COOKIE_PASSWORD (at least 32 characters)');
  }
}

/** The `Set-Cookie` that carries a paused password sign-in to its emailed code. */
export async function pausedSignInCookie(env: Bindings, value: EmailVerification): Promise<string> {
  return emailVerificationCookie(
    await sealEmailVerification(await emailVerificationKey(env), value),
  );
}

/**
 * The paused sign-in this browser carries, for the address the page names —
 * or a refusal that says only that the attempt is over: no cookie, an altered
 * or expired one, or one sealed for a different address.
 */
export async function pausedSignInFor(
  env: Bindings,
  request: Request,
  email: string,
): Promise<EmailVerification> {
  const cookie = parseCookies(request.headers.get('cookie')).get(EMAIL_VERIFICATION_COOKIE_NAME);
  const opened = await openEmailVerification(await emailVerificationKey(env), cookie, new Date());
  if (!opened.ok) {
    throw new SignInRefusal('expired', 400, `email verification cookie ${opened.reason}`);
  }
  if (!isSameVerificationAddress(opened.value.email, email)) {
    throw new SignInRefusal('expired', 403, 'email verification cookie sealed for another address');
  }
  return opened.value;
}

/**
 * The shared tail, as JSON: the exchange through `completeSignIn`, and the
 * page told where to go — `next` (held to `safePostSignInPath` here, at the
 * moment of use) with the session cookies, or the confirmation with its sealed
 * cookie.
 *
 * `issuedAt` is when the flow began: this request, unless the sign-in was
 * paused for an emailed code, when it is the paused step's — so the
 * confirmation's reused-session check is measured from the moment the person
 * first authenticated, not from the minutes they spent finding the email.
 */
export async function finishInAppSignIn(
  services: ServiceContext,
  request: Request,
  params: {
    exchange: AuthorizationCodeExchange<WorkosIdentity>;
    provider: Pick<WorkosIdentityProvider, 'verifiedDomains' | 'clientId'>;
    next: string | undefined;
    issuedAt?: number;
    extraCookies?: readonly string[];
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
    flow: { organizationId: null, issuedAt: params.issuedAt ?? now() },
    next,
    cookies: parseCookies(request.headers.get('cookie')),
  });
  const extra = params.extraCookies ?? [];
  return done.kind === 'parked'
    ? json({ redirect: SIGN_IN_CONFIRM_PATH }, { cookies: [done.cookie, ...extra] })
    : json({ redirect: next }, { cookies: [...done.cookies, ...extra] });
}

/** Which field a refused credential belongs to, for the sentence beside it. */
export type CredentialField = 'password' | 'code';

/**
 * Any failure of an in-app sign-in, as the JSON the page's form shows.
 *
 *  - The request's own faults (`csrf_failed`, `validation_failed`) pass
 *    through as the API answers them anywhere.
 *  - **A refused credential** ({@link RefusedCredential}) — a wrong password,
 *    an address with no account (the same answer), a wrong or expired code,
 *    and the answers folded into them: a 400 with the sentence beside the
 *    field, from `SIGN_IN_FORM_MESSAGES`. Logged at `warn` with WorkOS's own
 *    reason, which is a bounded log-safe token.
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
  clear: readonly string[] = [],
): Response {
  const requestId = services.meta.requestId;

  if (cause instanceof ApiError) {
    services.bindLog({ signInOutcome: 'refused', signInRefusal: cause.code });
    return json(cause.toBody(requestId), { status: cause.status, cookies: clear });
  }

  if (credential !== null && cause instanceof RefusedCredential) {
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
  return json(error.toBody(requestId), { status, cookies: clear });
}

/** The cookie that ends a paused sign-in, for the answers that end it. */
export function endedPausedSignIn(): string {
  return clearedEmailVerificationCookie();
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
