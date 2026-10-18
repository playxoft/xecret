/**
 * The one check every `?next=` passes before anything navigates to it.
 *
 * Its own module, free of any import, because three places need the identical
 * answer and they live on both sides of the network: the sign-in page (a server
 * component), `GET /api/auth/login` (which writes the value into the signed
 * state cookie the callback later redirects to), and the API client's 401
 * bounce in the browser. A second copy of this logic is a second definition of
 * "safe", and the one that disagrees is the open redirect. The stricter rule
 * for a completed sign-in, {@link safePostSignInPath}, is built on this one
 * rather than beside it.
 */

/**
 * The longest `next` accepted. It travels inside the sign-in state cookie, and a
 * browser caps a cookie at 4 KB; the CLI consent screen's own query string — the
 * longest legitimate `next` there is — is well under half of this.
 */
export const MAX_REDIRECT_PATH_LENGTH = 2048;

/** A stand-in origin to resolve against. `.invalid` is reserved and never resolves. */
const PROBE_ORIGIN = 'https://redirect-check.invalid';

/**
 * Accepts only a same-origin absolute path, and returns it normalised.
 *
 * The `?next=` parameter is attacker-supplied, and a sign-in that forwards to an
 * arbitrary URL after authenticating is a phishing primitive: the victim really
 * did sign in to the real site, then landed on the attacker's.
 *
 * Prefix checks alone are not enough, and each rule below is a bypass somebody
 * has used:
 *
 *  - `//evil.example` and `/\evil.example` are protocol-relative in browsers.
 *  - A tab, newline or carriage return is *removed* by the URL parser before it
 *    looks at anything, so `/\t/evil.example` becomes `//evil.example` after it
 *    passed a check that saw a single leading slash. Every control character is
 *    refused outright, and so is a backslash anywhere — browsers treat it as a
 *    slash in the path.
 *  - Then the value is resolved against a fixed origin with the real URL parser,
 *    and must still be on that origin. The value returned is the parser's
 *    reading of it rather than the string that went in.
 *  - **And that reading is checked again**, because it is a different string.
 *    Dot-segment removal is exactly where a safe-looking input turns unsafe:
 *    `/.//evil.example`, `/..//evil.example`, `/%2e//evil.example` and
 *    `/a/..//evil.example` all pass every check above, resolve on the probe
 *    origin, and *normalise to* `//evil.example` — a protocol-relative URL
 *    that a browser follows off-site. Every rule that applies to the input
 *    therefore applies to the output too; `isSafeSamePath` is that one rule,
 *    run twice. The result is a fixed point: passing it back in returns it
 *    unchanged.
 *
 * ── And never an API route ──
 * Same-origin is not the same as harmless. Every redirect to `next` is a
 * top-level navigation the browser makes as the person, carrying their cookies
 * and arriving with same-origin fetch metadata — and an `/api/` route answers
 * a GET by *doing* something. Review round 2 found the one that mattered:
 * `next=/api/auth/login?org=attacker-co` turned the sign-in confirmation's
 * truthful "Continue" into a same-origin request for the attacker's single
 * sign-on, which is exactly the request the login route honoured. Nothing a
 * person should land on lives under `/api/`, so no `next` may point there.
 * Checked on the decoded, lower-cased path, with backslashes read as slashes,
 * so that `/API/…`, `/%61pi/…` and `/api%2F…` are refused too.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || !isSafeSamePath(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (isApiPath(url.pathname)) return fallback;

  const normalised = `${url.pathname}${url.search}${url.hash}`;
  return isSafeSamePath(normalised) ? normalised : fallback;
}

/**
 * Where a **completed** sign-in may send the browser: {@link safeRedirectPath},
 * and never one of the sign-in screens themselves ({@link AUTH_SCREEN_PATHS}).
 *
 * For the three places a `next` is sealed or followed once somebody has signed
 * in — the login route that seals it, and the callback and the confirmation
 * that redirect to it — and nowhere else (review round 3). A sign-in that
 * finished and then landed on a sign-in screen reads as "one more step", and
 * the one screen that asks for a click is the SSO warning page:
 * `next=/sign-in?org=attacker-co` would chain a person's real, successful
 * sign-in straight onto the attacker's organisation's "Continue", looking like
 * the second half of what they had just done. `/forgot-password?org=…` is the
 * same request one hop later — Next's permanent redirect to `/sign-in` carries
 * the query across. Nobody who has just signed in wants any of these screens,
 * so each falls back to `fallback`.
 *
 * {@link safeRedirectPath} itself still lets `/sign-in?org=` through: the
 * warning page is a real page that people reach directly — the login route
 * sends every unconfirmed deep link there, and the sign-in screens link to one
 * another keeping `next` — and none of that is a completed sign-in's `next`.
 * Checked the way the `/api` refusal is: decoded until it settles, backslashes
 * as slashes, dot segments resolved, lower-cased, and each screen's own
 * sub-paths with it (`/sign-in/confirm` included).
 */
export function safePostSignInPath(value: string | null | undefined, fallback: string): string {
  const path = safeRedirectPath(value, fallback);
  return isAuthScreenPath(new URL(path, PROBE_ORIGIN).pathname) ? fallback : path;
}

/**
 * The sign-in screens: the two pages that start one, and the two paths that
 * redirect to them (`next.config.ts` — the Firebase-era password-reset links,
 * still in inboxes).
 */
export const AUTH_SCREEN_PATHS = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
] as const;

/**
 * Whether a path, as the server might route it, is under `/api` — read the
 * way {@link routedPath} reads it, and counting anything it cannot read as
 * one. Errs towards "yes": the cost of a false positive is a sign-in that
 * lands on `/app` instead.
 */
export function isApiPath(pathname: string): boolean {
  const path = routedPath(pathname);
  return path === null || isAtOrUnder(path, '/api');
}

/**
 * Whether a path, as the server might route it, is one of
 * {@link AUTH_SCREEN_PATHS} or under one. Errs towards "yes", as
 * {@link isApiPath} does, and for the same reason.
 */
export function isAuthScreenPath(pathname: string): boolean {
  const path = routedPath(pathname);
  return path === null || AUTH_SCREEN_PATHS.some((screen) => isAtOrUnder(path, screen));
}

/**
 * A path as the server might route it — decoded until it stops changing (a
 * handful of rounds at most), backslashes read as slashes, runs of slashes
 * collapsed, dot segments resolved again after decoding, and lower-cased — or
 * `null` for one that will not settle or will not decode.
 */
function routedPath(pathname: string): string | null {
  let decoded = pathname;
  for (let round = 0; ; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    if (round === 3) return null;
    decoded = next;
  }
  try {
    const flattened = `/${decoded.replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
    return new URL(flattened, PROBE_ORIGIN).pathname.toLowerCase();
  } catch {
    return null;
  }
}

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The shape rules, on their own: a non-empty, bounded path rooted at a single
 * slash, with no control character and no backslash anywhere.
 *
 * Exported so that a value which has travelled — through the signed state
 * cookie, say — can be held to the same rules again where it is used, without
 * a second spelling of them.
 */
export function isSafeSamePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REDIRECT_PATH_LENGTH &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !/[\u0000-\u001f\u007f\\]/.test(value)
  );
}
