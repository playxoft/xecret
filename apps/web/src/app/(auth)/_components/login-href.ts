import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@xecret/core/validation';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';

/**
 * The links that start a sign-in, and the links between the two screens that
 * offer one.
 *
 * Sign-in itself happens on AuthKit's hosted page. Every screen here does one
 * thing — sends the browser to `GET /api/auth/login` — and the only part of
 * that worth getting wrong is the query string, because it carries `next`
 * through a hop the person never sees. That matters most for `xecret login`:
 * the CLI opens `/cli/authorize?challenge=…&port=…&device=…&state=…`, the API
 * client's 401 bounce turns that into `/sign-in?next=<the whole thing,
 * encoded>`, and the consent screen only comes back if every byte of its query
 * string survives the trip into the state cookie and out of the callback's
 * redirect. A `next` that loses its `&port=` lands somebody on a consent screen
 * that cannot answer the CLI waiting for it.
 *
 * So the query is built with `URLSearchParams`, which is the exact inverse of
 * the `url.searchParams.get('next')` the login route reads it back with — the
 * same encoder on one side and decoder on the other, rather than a hand-rolled
 * `encodeURIComponent` whose agreement with the parser is something to argue
 * about. The round trip is pinned in `login-href.test.ts`.
 *
 * Pure, and free of anything browser- or server-only, so a Server Component
 * page, a client card on the security screen and a unit test can all call it.
 */

/** `GET` — validates `next`, writes the state cookie, and 307s to AuthKit. */
export const LOGIN_ROUTE = '/api/auth/login';

export interface LoginHrefOptions {
  /**
   * Where to land afterwards. Validated again here (and by the login route,
   * and once more by the callback before it redirects — the checks that
   * count). Re-validating a value `safeRedirectPath` already returned is safe:
   * it re-checks its own normalised output, so what it returns is a fixed
   * point and passes through unchanged (pinned, with a fuzz, in
   * `lib/redirect-path.test.ts`). Normalising first is what makes the "omit
   * the default" comparison below reliable — `/app?` and `/app` are the same
   * destination and get the same link.
   */
  next?: string | null | undefined;
  /** Open AuthKit on its sign-up screen rather than its sign-in screen. */
  signUp?: boolean;
  /**
   * Sign in again even though AuthKit may hold a session of its own
   * (`max_age=0`). Without this, a person signed in to AuthKit is bounced
   * straight back without ever seeing the hosted page — right for signing in,
   * wrong for somebody who went there to change their password. AuthKit then
   * asks for a password or passkey again; it does not make Google or a
   * company's identity provider re-prompt (ADR 0010).
   */
  reauth?: boolean;
  /**
   * Start this organisation's single sign-on directly — the SSO deep link.
   * The login route honours it only with {@link continueToken} (review round
   * 2); without one — or followed from anywhere else — it lands on the sign-in
   * page's warning first. Ignored with `reauth` and with `signUp`, as the login
   * route ignores it on a re-authentication.
   */
  org?: string | null | undefined;
  /**
   * The warning page's "Continue" token for `org` (`@xecret/core/auth`,
   * `sso-continue.ts`), minted on the server for this browser. Sent only
   * beside `org`; a link that is shared or bookmarked should leave it out and
   * let the login route send the person to the warning page.
   */
  continueToken?: string | null | undefined;
}

/** The `/api/auth/login` link for one way into AuthKit. */
export function loginHref({
  next,
  signUp = false,
  reauth = false,
  org = null,
  continueToken = null,
}: LoginHrefOptions = {}): string {
  const query = new URLSearchParams();
  // The login route ignores `hint` on a re-authentication — re-authenticating
  // is a sign-in, never a sign-up — so it is not sent alongside one either.
  if (reauth) query.set('reauth', '1');
  else if (signUp) query.set('hint', 'sign-up');
  else if (org !== null && isOrgSlug(org)) {
    query.set('org', org);
    if (continueToken !== null && continueToken !== '') query.set('continue', continueToken);
  }
  appendNext(query, next);
  return withQuery(LOGIN_ROUTE, query);
}

/**
 * An organisation slug as the sign-in page may name it — the shape the login
 * route accepts — or `null` for anything else, which the page then ignores.
 *
 * The parameter is in a URL anybody can write, and it is printed on the page,
 * so it is held to the slug pattern before it is shown: lower-case letters,
 * digits and single hyphens, nothing that could read as a sentence.
 */
export function ssoOrgParam(value: string | null): string | null {
  return value !== null && isOrgSlug(value) ? value : null;
}

function isOrgSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** The two screens that start a sign-in, for the cross-link each shows the other. */
export type AuthScreen = '/sign-in' | '/sign-up';

/**
 * A link to the other authentication screen that keeps `next`.
 *
 * Somebody bounced to `/sign-in?next=/cli/authorize?…` who has no account yet
 * clicks "Create an account"; dropping `next` there would sign them up and then
 * strand them on the dashboard, with the terminal still waiting.
 */
export function authScreenHref(screen: AuthScreen, next?: string | null): string {
  const query = new URLSearchParams();
  appendNext(query, next);
  return withQuery(screen, query);
}

/**
 * Adds `next` unless it is the default destination. Every link without one
 * goes to `/app` anyway, so leaving the default off keeps the common case's
 * URL clean — and the address bar is a thing people copy into support tickets.
 */
function appendNext(query: URLSearchParams, next: string | null | undefined): void {
  const destination = safeRedirectPath(next, POST_SIGN_IN_PATH);
  if (destination !== POST_SIGN_IN_PATH) query.set('next', destination);
}

/**
 * The one value of a parameter from a page's `searchParams`.
 *
 * A parameter given twice arrives as an array, and counts as absent rather than
 * as either of its values — the same rule the sign-in callback applies, because
 * "which one did you mean" has no answer worth guessing for a redirect target.
 */
export function singleParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function withQuery(path: string, query: URLSearchParams): string {
  const search = query.toString();
  return search.length > 0 ? `${path}?${search}` : path;
}
