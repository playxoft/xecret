/**
 * The one check every `?next=` passes before anything navigates to it.
 *
 * Its own module, free of any import, because three places need the identical
 * answer and they live on both sides of the network: the sign-in page (a server
 * component), `GET /api/auth/login` (which writes the value into the signed
 * state cookie the callback later redirects to), and the API client's 401
 * bounce in the browser. A second copy of this logic is a second definition of
 * "safe", and the one that disagrees is the open redirect.
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
 * Whether a path, as the server might route it, is under `/api` — decoded until
 * it stops changing (a handful of rounds at most; anything that will not
 * settle, or will not decode, counts as one), backslashes read as slashes,
 * runs of slashes collapsed, dot segments resolved again after decoding, and
 * lower-cased. Errs towards "yes": the cost of a false positive is a sign-in
 * that lands on `/app` instead.
 */
export function isApiPath(pathname: string): boolean {
  let decoded = pathname;
  for (let round = 0; ; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    if (round === 3) return true;
    decoded = next;
  }
  let resolved: string;
  try {
    const flattened = `/${decoded.replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
    resolved = new URL(flattened, PROBE_ORIGIN).pathname;
  } catch {
    return true;
  }
  const path = resolved.toLowerCase();
  return path === '/api' || path.startsWith('/api/');
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
