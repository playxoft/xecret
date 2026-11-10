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
import type { CompletedSignIn } from './sign-in-completion';
import { SIGN_IN_CONFIRM_PATH } from './sign-in-confirmation';
import { classifySignInFailure, UNUSABLE_ANSWERS } from './sign-in-responses';
import { clearSignInPool, refundSignInAttemptFor, spendSignInAttemptFor } from './sign-in-throttle';
import type { ThrottlePool } from './sign-in-throttle';
import { AuthenticationStepRequired } from './workos';
import type { AuthenticationStepCode, WorkosIdentityProvider } from './workos';

/**
 * Signing in on xecret's own page — the server half.
 *
 * The sign-in and sign-up pages take a password, and the sign-up page the
 * six-digit code that proves the address, themselves, and post them here;
 * these routes check them with WorkOS's headless User Management API
 * (`WorkosIdentityProvider.signInWithPassword` and friends) and never send the
 * browser to a WorkOS page. "Continue with Google" is the one sign-in that
 * leaves the site, and it goes through the login route straight to Google and
 * back to the callback. A forgotten password is reset on the site too
 * (`server/password-reset.ts`).
 *
 * ── The routes, one tail ──
 *  - `POST /api/auth/sign-in/password` — email and password: the sign-in page.
 *  - `POST /api/auth/sign-in/code` — has WorkOS email a code (Magic Auth): the
 *    sign-up page's first step. The same for an address with an account and
 *    one without: WorkOS creates the WorkOS user when the address has none, and
 *    the answer never says which it was.
 *  - `POST /api/auth/sign-up` — that code, and the password chosen beside it:
 *    the code proves the inbox and signs in, and the password is set only on
 *    an account this sign-up created — never on one that already existed
 *    (`app/api/auth/sign-up/route.ts` has why).
 *  - `POST /api/auth/sign-in/code/verify` — an emailed code alone. **No page
 *    links here any more**: the sign-in page's "email me a code" was removed
 *    in favour of "Forgot password?". Kept, hardened and tested, as support's
 *    way to sign somebody in by their inbox.
 *  - `POST /api/auth/sign-in/verify-email` — the code WorkOS emails when a
 *    password sign-in reaches an address it has not verified
 *    (`email_verification_required`) — **off until proven safe**; see
 *    {@link emailVerificationStepEnabled}.
 *
 * Each sign-in ends in {@link finishInAppSignIn}: the exchange its WorkOS call minted
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
 *  2. **An address bucket** — `RL_LOGIN`, keyed on the caller's IP. The password,
 *     code and sign-up routes spend the key the callback spends; asking for a
 *     code, verifying an address, asking for a reset link and using one each
 *     have their own, so one flow's two steps do not spend one allowance twice.
 *  3. The body, parsed.
 *  4. **Per-subject buckets**, before WorkOS is asked: the address and the
 *     caller's IP for a guess (the guessing surface `attemptKey` was made for);
 *     the address alone for mail — a code request and a reset link spend the
 *     *same* key, one allowance per inbox whatever the mail carries, which an
 *     IP has no business multiplying — and for a code guess (a six-digit secret
 *     worth bounding however many addresses guess at it).
 *  5. **The durable throttle** (`server/sign-in-throttle.ts`,
 *     `sign_in_failures`): the attempt is counted — first, in one statement —
 *     against this browser's own pool when it carries a known-device cookie
 *     earned for the address, and against the address's shared pool
 *     otherwise; refused as rate-limited while that pool is locked. Global and
 *     in the database, so rotating IPs and data centres buys nothing, and an
 *     attacker can lock only the shared pool, never the owner's browser.
 *     `prepareSignIn` then spends the per-identity bucket, keyed on the WorkOS
 *     user, as it does for the callback. The password reset's two routes are
 *     the deliberate exception — the reset is the owner's way in while the
 *     shared pool is held locked, and its token names no address to count
 *     against (`server/password-reset.ts`).
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
 * password, and counted like one. The person's way in is "Forgot password?":
 * a reset verifies the address as it sets the password (WorkOS documents
 * both), and they then sign in with it.
 *
 * **Staging check before turning this on:** with a WorkOS user whose address
 * is unverified, a *wrong* password must answer `invalid_credentials`, and only
 * the right one `email_verification_required`. If so, set this to `true` — the
 * route, the cookie and the page are built and tested for it.
 *
 * ── What it costs while off ──
 * Somebody with an unverified address who types the *right* password is told
 * the password is wrong, has the attempt counted, and is mailed a verification
 * code by WorkOS that this page cannot accept. Their way in is "Forgot
 * password?" — the reset link verifies the address and sets a password they
 * then sign in with; the reset is never held back by the lockout — and enough
 * retries of the password lock their own shared pool first. The
 * counting is deliberate: an answer that is not counted while every wrong
 * password is would itself be an oracle — the lockout would arrive later for an
 * unverified address than for any other, and that difference names it.
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
export type AddressBucket =
  'sign-in' | 'code-send' | 'verify-email' | 'password-reset' | 'password-reset-confirm';

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
    case 'password-reset':
      return rateLimitKey(['password_reset_ip', ip]);
    case 'password-reset-confirm':
      return rateLimitKey(['password_reset_confirm_ip', ip]);
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

/**
 * The per-subject key for an emailed code: the address alone, lower-cased.
 * `send` is every mail these routes have WorkOS send to an inbox — a sign-up
 * code and a password-reset link spend the same allowance.
 */
export function codeKey(purpose: 'send' | 'guess', email: string): string {
  return rateLimitKey([
    purpose === 'send' ? 'sign_in_code' : 'sign_in_code_guess',
    email.toLowerCase(),
  ]);
}

/**
 * The earliest a route that mails an inbox answers, from the moment its
 * request arrived. Those routes answer every address alike, and the *answer*
 * is the easy half: WorkOS takes longer to make a user, a code or a reset for
 * an address than to refuse one it has no user for, and that difference is a
 * stopwatch's oracle for which addresses have accounts. Holding both answers to
 * the same floor flattens it while WorkOS answers inside it; a WorkOS slower
 * than the floor still shows through, as a weak signal, and only while it is
 * slow. It costs a person who asked for an email a second they spend opening
 * their mail anyway.
 */
export const MAIL_ANSWER_FLOOR_MS = 1200;
let mailAnswerFloorMs = MAIL_ANSWER_FLOOR_MS;

/** Exists for tests. `null` restores the default. */
export function setMailAnswerFloorForTesting(ms: number | null): void {
  mailAnswerFloorMs = ms ?? MAIL_ANSWER_FLOOR_MS;
}

/** Waits out the rest of {@link MAIL_ANSWER_FLOOR_MS}, if any is left. */
export async function holdMailAnswer(services: ServiceContext): Promise<void> {
  const remaining = services.meta.startedAt + mailAnswerFloorMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * A password WorkOS's policy refused, as the 400 beside the password field —
 * the reset's, with a link WorkOS accepted. (The sign-up never answers this: it
 * sets a password only after the account exists and is signed in, and says so
 * in a notice instead.) Only ever given once the inbox is proven, so it says
 * nothing about the address to anybody who does not already hold it.
 */
export function weakPasswordAnswer(services: ServiceContext): Response {
  const message = SIGN_IN_FORM_MESSAGES['weak-password'];
  services.log.at('signIn').warn('WorkOS refused a new password under its password policy', {
    status: 400,
  });
  services.bindLog({ signInOutcome: 'refused', signInRefusal: 'weak-password' });
  const error = new ApiError('bad_request', message, {
    fields: [{ field: 'password', message }],
  });
  return json(error.toBody(services.meta.requestId), { status: 400 });
}

/** Whether `cause` is WorkOS's password policy refusing a new password. */
export function isWeakPassword(cause: unknown): boolean {
  return cause instanceof IdentityVerificationError && cause.reason === 'weak-password';
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
 * Step 5 and the WorkOS call, for one guess at a credential
 * (`server/sign-in-throttle.ts` has the design):
 *
 *  1. **Count it first** against its pool, or refuse it as rate-limited while
 *     the pool is locked — one statement, so a concurrent burst cannot slip
 *     past the end of the free attempts together.
 *  2. Ask WorkOS.
 *  3. Accepted → clear the pool. Refused, or answered in a way folded into a
 *     refusal (`fold`) → the up-front count stands. Anything else — WorkOS
 *     unavailable, timed out, rate-limiting us, or asking for a step this page
 *     does not fold — was never a judgement of the guess: the count is
 *     refunded, and the cause passes through untouched.
 */
export async function checkCredential(
  services: ServiceContext,
  pool: ThrottlePool,
  attempt: () => Promise<AuthorizationCodeExchange<WorkosIdentity>>,
  fold: ReadonlySet<AuthenticationStepCode> = FOLDED_STEPS,
): Promise<AuthorizationCodeExchange<WorkosIdentity>> {
  await spendSignInAttemptFor(services, pool);
  let exchange: AuthorizationCodeExchange<WorkosIdentity>;
  try {
    exchange = await attempt();
  } catch (cause) {
    if (isRefusedCredential(cause, fold)) {
      throw new RefusedCredential(
        cause instanceof IdentityVerificationError ? cause.reason : 'refused',
      );
    }
    await refundSignInAttemptFor(services, pool);
    throw cause;
  }
  await clearSignInPool(services, pool);
  return exchange;
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
    /**
     * Runs once the sign-in is complete — issued, or held back for
     * confirmation — with the linker's outcome, and adds fields to the answer.
     * The sign-up's: it sets the chosen password only on an account this
     * sign-in created. It must not throw: by the time it runs, the session (or
     * the held-back sign-in) exists, and a throw would answer the page with an
     * error and no cookie for it.
     */
    after?: (done: CompletedSignIn) => Promise<Record<string, unknown>>;
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
  const fields = params.after === undefined ? {} : await params.after(done);
  return done.kind === 'parked'
    ? json({ ...fields, redirect: SIGN_IN_CONFIRM_PATH }, { cookies: [done.cookie, ...extra] })
    : json({ ...fields, redirect: next }, { cookies: [...done.cookies, ...extra] });
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
