import { IdentityVerificationError } from '@xecret/core/auth';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import type { SignInErrorCode } from '@/lib/sign-in-errors';
import { MissingBindingError } from './bindings';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { SignInRefusal } from './sign-in';
import { IdentityProviderUnavailableError } from './workos';

/**
 * How the two routes that finish a sign-in answer — the callback, and the
 * confirmation that a held-back sign-in finishes at. Both are top-level
 * navigations a person is watching, so both answer every outcome with a 303:
 * to `next` on success, to `/sign-in?error=<code>` on any refusal. A JSON error
 * on a blank tab is a dead end.
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
  if (reason === 'no-email' || reason === 'malformed-subject' || reason === 'malformed-identity') {
    return `Refused a sign-in because WorkOS's answer could not be used (${reason}).`;
  }
  return `Refused a sign-in because WorkOS would not exchange its code (${reason}).`;
}

/**
 * Turns any failure into a redirect to the sign-in page's error surface — and a
 * log line that says what really happened.
 *
 * Three kinds of failure, and the log level follows them:
 *
 *  - **A refusal** (`SignInRefusal`): the system working. Logged at `warn` with
 *    the status it stands for, because a burst of them is the shape of
 *    somebody probing the door.
 *  - **The provider unreachable or misconfigured**, or a binding missing: an
 *    operator's problem. `error`, and the person is told sign-in is
 *    unavailable rather than that they did something wrong.
 *  - **Anything else** — a programming error, the database — `error`, with the
 *    stack, and the person is told only that it failed.
 *
 * A code the provider refused (expired, replayed, a PKCE mismatch) is a
 * refusal, reported as an expired attempt: naming which part was wrong tells an
 * attacker which part of a forged request to fix next.
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
  const log = services.log.at('callback');
  let code: SignInErrorCode;

  if (cause instanceof SignInRefusal) {
    code = cause.code;
    log.warn(`Refused a sign-in: ${cause.logDetail}`, { code, status: cause.status });
  } else if (cause instanceof IdentityVerificationError) {
    code = 'expired';
    log.warn(
      `${verificationFailure(cause.reason)} The person was told only that the attempt expired.`,
      { code, status: 400, reason: cause.reason },
    );
  } else if (cause instanceof IdentityProviderUnavailableError) {
    code = cause.reason === 'rate-limited' ? 'rate-limited' : 'unavailable';
    log.error(
      `Could not complete a sign-in because WorkOS was ${cause.reason} — every sign-in fails ` +
        'the same way until this is resolved',
      { code, status: cause.reason === 'rate-limited' ? 429 : 503, reason: cause.reason },
    );
  } else if (cause instanceof MissingBindingError) {
    code = 'unavailable';
    log.error(
      `This deployment is missing ${cause.binding}, so nobody can sign in until it is configured`,
      { code, status: 503, binding: cause.binding },
    );
  } else {
    code = 'failed';
    log.error('An unexpected error ended a sign-in — the person was told only that it failed', {
      code,
      status: 500,
      error: describeError(cause),
    });
  }

  // The completion line for this request reads as a neutral "completed a
  // sign-in callback" whatever happened; these fields are what say it was
  // refused, and why, so that a refused sign-in is never counted as a success.
  services.bindLog({ signInOutcome: 'refused', signInRefusal: code });

  const target = new URLSearchParams({ error: code });
  if (next !== null && next !== POST_SIGN_IN_PATH) target.set('next', next);
  return seeOther(`${SIGN_IN_PATH}?${target.toString()}`, clear);
}
