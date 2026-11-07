import { IdentityVerificationError } from '@xecret/core/auth';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import type { SignInErrorCode } from '@/lib/sign-in-errors';
import { MissingBindingError } from './bindings';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { SignInRefusal } from './sign-in';
import { AuthenticationStepRequired, IdentityProviderUnavailableError } from './workos';
import type { AuthenticationStepCode } from './workos';

/**
 * How the routes that finish a sign-in answer a failure.
 *
 * Two shapes, one judgement. The callback, and the confirmation a held-back
 * sign-in finishes at, are top-level navigations a person is watching, so they
 * answer every outcome with a 303: to `next` on success, to
 * `/sign-in?error=<code>` on any refusal — a JSON error on a blank tab is a dead
 * end. The in-app sign-in routes answer the sign-in page's own form, in JSON
 * (`server/in-app-sign-in.ts`). Both decide *which* refusal it was, and what to
 * log about it, in {@link classifySignInFailure}, so a refusal is the same code,
 * the same sentence and the same log line whichever way the person came in.
 */

/** A 303 to `location`, setting `cookies`, never cached. */
export function seeOther(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({
    location,
    // The URL a callback answers carries a one-time code, already spent. The
    // site-wide `strict-origin-when-cross-origin` (next.config.ts) keeps the
    // query out of any cross-site referrer, and Next applies it over anything
    // a route sets, so no header of its own is needed here.
    'cache-control': 'no-store',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Which side of the WorkOS call an `IdentityVerificationError` came from, for
 * the log. A code refused by shape never reached WorkOS, and an answer that
 * could not be used did — "WorkOS would not exchange its code" is true of
 * neither, and a person reading the log at 3 a.m. would go looking at WorkOS.
 */
function verificationFailure(reason: string): string {
  if (reason === 'malformed-code') {
    return 'Refused a sign-in before asking WorkOS: the code in the callback URL was malformed.';
  }
  if (UNUSABLE_ANSWERS.has(reason)) {
    return `Refused a sign-in because WorkOS's answer could not be used (${reason}).`;
  }
  return `Refused a sign-in because WorkOS would not exchange its code (${reason}).`;
}

/**
 * The verification failures that are WorkOS's *answer* being unusable rather
 * than WorkOS refusing what was presented — never "your password is wrong".
 */
export const UNUSABLE_ANSWERS: ReadonlySet<string> = new Set([
  'no-email',
  'malformed-subject',
  'malformed-identity',
]);

/**
 * What the person is told when WorkOS answered with a step instead of a user.
 * Each is specific, because "that attempt expired" for a right password is the
 * answer that sends somebody round in circles.
 *
 *  - The authenticator steps: no account has multi-factor today (it is off in
 *    both WorkOS environments), and the sign-in page cannot take a TOTP code
 *    yet. A clear refusal rather than a half-built challenge screen; the
 *    challenge itself is a documented follow-up.
 *  - `email_verification_required`: the password route answers this one with
 *    a code step of its own; anywhere else it is the "verify your address"
 *    refusal the linker would give.
 *  - `sso_required`, `organization_authentication_methods_required`: WorkOS's
 *    own domain policy — this address belongs to an organisation that signs in
 *    only through its identity provider.
 *  - `organization_selection_required`: completed by the provider itself
 *    (`WorkosIdentityProvider`); one that escapes it named no organisation to
 *    continue into, which is a failure, not the person's.
 *  - The Radar challenges: bot protection this page cannot show (Radar is not
 *    integrated with the in-app page yet — a documented follow-up).
 */
const STEP_REFUSALS: Record<AuthenticationStepCode, SignInErrorCode> = {
  mfa_challenge: 'authenticator-required',
  mfa_enrollment: 'authenticator-required',
  mfa_verification: 'authenticator-required',
  email_verification_required: 'verify-email',
  sso_required: 'sso-required',
  organization_authentication_methods_required: 'sso-required',
  organization_selection_required: 'failed',
  radar_email_challenge: 'extra-check',
  radar_sms_challenge: 'extra-check',
};

/** The refusal a WorkOS step stands for. */
export function stepRefusal(step: AuthenticationStepRequired): SignInRefusal {
  return new SignInRefusal(
    STEP_REFUSALS[step.code],
    403,
    `WorkOS asked for a step this sign-in does not take (${step.code})`,
  );
}

/** A failure, judged: the code the person is told, and the status it stands for. */
export interface ClassifiedSignInFailure {
  code: SignInErrorCode;
  status: number;
}

/**
 * Turns any failure into the refusal the person is told about — and a log
 * line that says what really happened.
 *
 * Three kinds of failure, and the log level follows them:
 *
 *  - **A refusal** (`SignInRefusal`, or a WorkOS step this sign-in does not
 *    take): the system working. Logged at `warn` with the status it stands
 *    for, because a burst of them is the shape of somebody probing the door.
 *  - **The provider unreachable or misconfigured**, or a binding missing: an
 *    operator's problem. `error`, and the person is told sign-in is
 *    unavailable rather than that they did something wrong.
 *  - **Anything else** — a programming error, the database — `error`, with the
 *    stack, and the person is told only that it failed.
 *
 * A code the provider refused (expired, replayed, a PKCE mismatch) is a
 * refusal, reported as an expired attempt: naming which part was wrong tells an
 * attacker which part of a forged request to fix next. (The in-app routes
 * answer a refused password or emailed code before this, beside the field.)
 */
export function classifySignInFailure(
  services: ServiceContext,
  cause: unknown,
): ClassifiedSignInFailure {
  const log = services.log.at('signIn');
  let code: SignInErrorCode;
  let status: number;

  const refusal = cause instanceof AuthenticationStepRequired ? stepRefusal(cause) : cause;

  if (refusal instanceof SignInRefusal) {
    code = refusal.code;
    status = refusal.status;
    log.warn(`Refused a sign-in: ${refusal.logDetail}`, { code, status });
  } else if (refusal instanceof IdentityVerificationError) {
    code = 'expired';
    status = 400;
    log.warn(
      `${verificationFailure(refusal.reason)} The person was told only that the attempt expired.`,
      { code, status, reason: refusal.reason },
    );
  } else if (refusal instanceof IdentityProviderUnavailableError) {
    code = refusal.reason === 'rate-limited' ? 'rate-limited' : 'unavailable';
    status = refusal.reason === 'rate-limited' ? 429 : 503;
    log.error(
      `Could not complete a sign-in because WorkOS was ${refusal.reason} — every sign-in fails ` +
        'the same way until this is resolved',
      { code, status, reason: refusal.reason },
    );
  } else if (refusal instanceof MissingBindingError) {
    code = 'unavailable';
    status = 503;
    log.error(
      `This deployment is missing ${refusal.binding}, so nobody can sign in until it is configured`,
      { code, status, binding: refusal.binding },
    );
  } else {
    code = 'failed';
    status = 500;
    log.error('An unexpected error ended a sign-in — the person was told only that it failed', {
      code,
      status,
      error: describeError(refusal),
    });
  }

  // The completion line for this request reads as a neutral "completed a
  // sign-in" whatever happened; these fields are what say it was refused, and
  // why, so that a refused sign-in is never counted as a success.
  services.bindLog({ signInOutcome: 'refused', signInRefusal: code });
  return { code, status };
}

/**
 * Turns any failure into a redirect to the sign-in page's error surface.
 *
 * `clear` is the cookies the route always clears on its way out — the state
 * cookie for the callback, the confirmation cookie for the confirmation — so a
 * one-time value is used at most once per browser whatever happened.
 */
export function refusedSignIn(
  services: ServiceContext,
  cause: unknown,
  next: string | null,
  clear: readonly string[],
): Response {
  const { code } = classifySignInFailure(services, cause);
  return seeOther(signInErrorPath(code, next), clear);
}

/** `/sign-in?error=<code>`, keeping `next` unless it is the default. */
export function signInErrorPath(code: SignInErrorCode, next: string | null): string {
  const target = new URLSearchParams({ error: code });
  if (next !== null && next !== POST_SIGN_IN_PATH) target.set('next', next);
  return `${SIGN_IN_PATH}?${target.toString()}`;
}
