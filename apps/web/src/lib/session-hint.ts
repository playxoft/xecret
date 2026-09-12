/**
 * What a page may know about the session without asking the server, and the
 * two paths either answer leads to.
 *
 * Its own module, upstream of `lib/api.ts`, for one reason: the public chrome
 * needs these and must not import the API client. `components/marketing`
 * documents that rule and `app/layout.tsx` explains it — the landing page is
 * prerendered, and pulling `lib/api.ts` onto it would put the whole
 * request/CSRF/401 machinery into the bundle a first-time reader downloads.
 * Restating `'/app'` in the header instead is the version of this that is one
 * silent redirect away from wrong, so the constants moved down here and
 * `lib/api.ts` re-exports them for the callers that already had them.
 *
 * Nothing here touches the session cookie itself. It cannot: that one is
 * `HttpOnly`, which is the point of it.
 */

/** Set by the server on login; readable by JavaScript by design — it is the
 *  echo half of the double-submit pair, not a credential on its own. */
export const CSRF_COOKIE_NAME = '__Host-xecret_csrf';

export const SIGN_IN_PATH = '/sign-in';

/**
 * Where sign-in lands when the request carried no `?next=`.
 *
 * Declared in one place because the authentication screens, the dashboard's
 * own entry point and the landing page's `S` shortcut all need to agree on it.
 */
export const POST_SIGN_IN_PATH = '/app';

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  return readCookieFrom(document.cookie, name);
}

/** Split out from `document` so the parsing can be tested without a browser. */
export function readCookieFrom(cookie: string, name: string): string | null {
  for (const part of cookie.split('; ')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }
  return null;
}

/**
 * A guess — the best one available in the browser — at whether this visitor
 * already has a session.
 *
 * The CSRF cookie is set beside the session cookie on sign-in, cleared beside
 * it on sign-out, and given the same lifetime, so its presence tracks the
 * session closely. It is still only a hint: a session revoked server-side, or
 * one whose cookie the browser has dropped, leaves it standing.
 *
 * So this is only ever used to choose between two *destinations*, never to
 * decide what somebody may see. A wrong guess sends a signed-out visitor to
 * `/app`, where `GET /api/auth/me` answers 401 and `lib/api.ts` bounces them to
 * the sign-in screen with `?next=/app` — one extra hop, and exactly the journey
 * they would have had anyway. It is not, and must never become, a check that
 * grants access: every byte on the dashboard comes from `/api/**`, which
 * authenticates each request on its own.
 */
export function hasSessionHint(): boolean {
  return readCookie(CSRF_COOKIE_NAME) !== null;
}

/**
 * Where somebody pressing the sign-in shortcut should land: the dashboard if
 * they look signed in, the sign-in screen if they do not.
 */
export function signInDestination(): string {
  return hasSessionHint() ? POST_SIGN_IN_PATH : SIGN_IN_PATH;
}
