import {
  clearedOAuthStateCookie,
  LAST_ACCOUNT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  openLastAccount,
  openOAuthState,
  SESSION_COOKIE_NAME,
} from '@xecret/core/auth';
import { safePostSignInPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { parseCookies } from '@/server/http';
import { attemptKey, consume } from '@/server/rate-limit';
import { publicRoute } from '@/server/route';
import {
  confirmationReason,
  issueSignIn,
  lastAccountKey,
  oauthStateKey,
  prepareSignIn,
  SignInRefusal,
} from '@/server/sign-in';
import { parkSignIn, SIGN_IN_CONFIRM_PATH } from '@/server/sign-in-confirmation';
import { refusedSignIn, seeOther } from '@/server/sign-in-responses';
import { workosProvider } from '@/server/workos';

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
 *     the query string. This is the login-CSRF defence for a code that was
 *     never this browser's — the double-submit CSRF check cannot apply to a
 *     top-level navigation from another site — and a failure here ends the
 *     request before the code is even looked at.
 *  3. Whatever the provider said went wrong, if it said so.
 *  4. The code exchange: one authenticated call to WorkOS with this
 *     deployment's secret and the flow's PKCE verifier.
 *  5. `prepareSignIn` (`server/sign-in.ts`, steps 1–7), whose header lists its
 *     steps and why they are in that order.
 *  6. **Whether the person must confirm first** (`confirmationReason`). `state`
 *     cannot tell whose authentication came back, and an attacker who planted
 *     their own AuthKit session in this browser gets a code for *their*
 *     account against *this* browser's valid state (review S1). A sign-in that
 *     came back through an organisation the flow did not ask for, by the
 *     single sign-on of an organisation the account is not a member of (even
 *     one the flow asked for — review round 2), or from a session WorkOS
 *     reused without asking for an account other than the last one on this
 *     browser, is therefore not issued here: it is parked in a sealed,
 *     five-minute, single-use cookie, and the browser goes to
 *     `/sign-in/confirm` to answer "Continue as …?". Only that page's POST
 *     (`/api/auth/confirm`) issues the session — and nothing that changes an
 *     organisation (a just-in-time join) happens before it.
 *  7. Otherwise, `issueSignIn` and a 303 to `next` — never an API route, and
 *     never a sign-in screen (`safePostSignInPath`, checked again here at the
 *     moment of use).
 *
 * ── How it answers ──
 * Always with a 303 — to `next`, to the confirmation, or to
 * `/sign-in?error=<code>` on any refusal — and always clearing the state
 * cookie, so one state is used at most once per browser. A refusal is still the
 * status it is (403, 409, …) in the log line; it is not the status of the
 * response, because this is a page load, and a JSON body on a blank tab is a
 * dead end for the person reading it.
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
    // Checked again, here, where it is used. The login route validated it
    // before sealing it and the cookie's MAC says nobody changed it since — but
    // the redirect is the moment an unsafe value would do its damage, so it is
    // held to the same rule at that moment rather than trusted on the strength
    // of an earlier check in a different request.
    next = safePostSignInPath(flow.next, POST_SIGN_IN_PATH);

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

    const prepared = await prepareSignIn(services, {
      exchange,
      purpose: flow.purpose,
      provider,
      flowIssuedAt: flow.issuedAt,
    });

    const reason = confirmationReason({
      flow,
      exchange,
      prepared,
      lastAccountUserId: await openLastAccount(
        await lastAccountKey(services.env),
        cookies.get(LAST_ACCOUNT_COOKIE_NAME),
      ),
    });
    if (reason !== null) {
      // Logged at `info`, with what was asked against what came back: one of
      // these is a person signing in through their company's identity
      // provider from the plain button; a burst of them for one address is
      // the planted-session attack being tried.
      services.log
        .at('callback')
        .info(
          'Held a sign-in back for the person to confirm: it came back through an organisation ' +
            'this flow did not ask for, through the single sign-on of one the account is not in, ' +
            'or from a session WorkOS reused without asking',
          {
            reason,
            askedForOrganization: flow.organizationId !== null,
            signInMethod: prepared.facts.signInMethod,
          },
        );
      const parked = await parkSignIn(services, {
        prepared,
        purpose: flow.purpose,
        next,
        flowIssuedAt: flow.issuedAt,
        reason,
      });
      services.bindLog({ signInOutcome: 'confirmation-required', signInPurpose: flow.purpose });
      return seeOther(SIGN_IN_CONFIRM_PATH, [parked, clearedOAuthStateCookie()]);
    }

    const result = await issueSignIn(services, {
      user: prepared.user,
      outcome: prepared.outcome,
      facts: prepared.facts,
      purpose: flow.purpose,
      lockOne: prepared.lockOne,
      freshAuthAt: prepared.freshAuthAt,
      providerSessionId: prepared.providerSessionId,
      workosClientId: provider.clientId,
      confirmation: null,
      presentedSessionToken: cookies.get(SESSION_COOKIE_NAME) ?? null,
    });

    services.bindLog({ signInOutcome: result.outcome, signInPurpose: flow.purpose });
    return seeOther(next, [...result.cookies, clearedOAuthStateCookie()]);
  } catch (cause) {
    return refusedSignIn(services, cause, next, [clearedOAuthStateCookie()]);
  }
});

/** The one value of a query parameter, or `null` when it is absent or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}
