import {
  clearedOAuthStateCookie,
  IdentityVerificationError,
  OAUTH_STATE_COOKIE_NAME,
  openOAuthState,
  SESSION_COOKIE_NAME,
} from '@xecret/core/auth';
import { POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/session-hint';
import type { SignInErrorCode } from '@/lib/sign-in-errors';
import { MissingBindingError } from '@/server/bindings';
import type { ServiceContext } from '@/server/context';
import { parseCookies } from '@/server/http';
import { describeError } from '@/server/logging';
import { attemptKey, consume } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import { completeSignIn, oauthStateKey, SignInRefusal } from '@/server/sign-in';
import { IdentityProviderUnavailableError, workosProvider } from '@/server/workos';

/**
 * Where AuthKit sends the browser back to — the only endpoint that turns an
 * outside identity into an xecret session.
 *
 * `publicRoute`, because it *establishes* authentication rather than requiring
 * it, which makes it the most exposed endpoint in the product. So the order is
 * deliberate, and nothing reaches the identity provider or the database until
 * the cheaper checks in front of it have passed:
 *
 *  1. Rate limit, on the caller's address.
 *  2. The state cookie: its MAC, its age, and its `state` against the one in
 *     the query string. This is the login-CSRF defence — the double-submit CSRF
 *     check cannot apply to a top-level navigation from another site — and a
 *     failure here ends the request before the code is even looked at.
 *  3. Whatever the provider said went wrong, if it said so.
 *  4. The code exchange: one authenticated call to WorkOS with this
 *     deployment's secret and the flow's PKCE verifier.
 *  5. Everything after that is `completeSignIn` (`server/sign-in.ts`), whose
 *     header lists its steps and why they are in that order.
 *
 * ── How it answers ──
 * Always with a 303 — to `next` on success, to `/sign-in?error=<code>` on any
 * refusal — and always clearing the state cookie, so one state is used at most
 * once per browser. A refusal is still the status it is (403, 409, …) in the
 * log line; it is not the status of the response, because this is a page load,
 * and a JSON body on a blank tab is a dead end for the person reading it.
 */
export const GET = publicRoute(async ({ request, services }) => {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  // Known once the state cookie has verified — and only then, because before
  // that it is a value an attacker could have written.
  let next: string | null = null;

  try {
    const byAddress = await consume(
      services.env,
      'RL_LOGIN',
      attemptKey(services.meta.ipAddress, null),
    );
    if (!byAddress.allowed) throw new SignInRefusal('rate-limited', 429, 'per-address limit');

    const provider = workosProvider(services.env);
    const key = await oauthStateKey(services.env);

    // A parameter given twice is refused rather than resolved: "which one did
    // you mean" has no safe answer for a value that decides who signs in.
    const presentedState = single(url.searchParams, 'state');
    const opened = await openOAuthState(
      key,
      cookies.get(OAUTH_STATE_COOKIE_NAME),
      presentedState,
      new Date(),
    );
    if (!opened.ok) throw new SignInRefusal('expired', 400, `state ${opened.reason}`);
    const { value: flow } = opened;
    next = flow.next;

    const providerError = url.searchParams.get('error');
    if (providerError !== null) {
      throw new SignInRefusal(
        providerError === 'access_denied' ? 'cancelled' : 'failed',
        400,
        `provider error ${providerError.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)}`,
      );
    }

    const code = single(url.searchParams, 'code');
    if (code === null) throw new SignInRefusal('expired', 400, 'no code');

    const exchange = await provider.exchangeCode(code, {
      codeVerifier: flow.verifier,
      ipAddress: services.meta.ipAddress,
      userAgent: services.meta.userAgent,
    });

    const result = await completeSignIn(services, {
      exchange,
      purpose: flow.purpose,
      provider,
      presentedSessionToken: cookies.get(SESSION_COOKIE_NAME) ?? null,
    });

    return seeOther(flow.next, [...result.cookies, clearedOAuthStateCookie()]);
  } catch (cause) {
    return refused(services, cause, next);
  }
});

/** The one value of a query parameter, or `null` when it is absent or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function seeOther(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({
    location,
    // The URL this response answered carries a one-time code, already spent.
    // The site-wide `strict-origin-when-cross-origin` (next.config.ts) keeps
    // the query out of any cross-site referrer, and Next applies it over
    // anything a route sets, so no header of its own is needed here.
    'cache-control': 'no-store',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
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
 */
function refused(services: ServiceContext, cause: unknown, next: string | null): Response {
  const log = services.log.at('callback');
  let code: SignInErrorCode;

  if (cause instanceof SignInRefusal) {
    code = cause.code;
    log.warn(`Refused a sign-in: ${cause.logDetail}`, { code, status: cause.status });
  } else if (cause instanceof IdentityVerificationError) {
    code = 'expired';
    log.warn(
      `Refused a sign-in because WorkOS would not exchange its code (${cause.reason}). The ` +
        'person was told only that the attempt expired.',
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

  const target = new URLSearchParams({ error: code });
  if (next !== null && next !== POST_SIGN_IN_PATH) target.set('next', next);
  return seeOther(`${SIGN_IN_PATH}?${target.toString()}`, [clearedOAuthStateCookie()]);
}
