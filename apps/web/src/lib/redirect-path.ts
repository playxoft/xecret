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
 *    and must still be on that origin. Whatever the checks above missed, the
 *    parser has the final word, and the value returned is the parser's reading
 *    of it rather than the string that went in.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (value.length > MAX_REDIRECT_PATH_LENGTH) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;

  const normalised = `${url.pathname}${url.search}${url.hash}`;
  return normalised.length > MAX_REDIRECT_PATH_LENGTH ? fallback : normalised;
}
