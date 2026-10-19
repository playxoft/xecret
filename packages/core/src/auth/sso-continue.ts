import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from '../crypto/encoding';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../validation/slug';
import { deriveCookieKey } from './oauth-state';

/**
 * The proof that an SSO deep link (`GET /api/auth/login?org=<slug>`) was
 * continued from the `/sign-in?org=` warning page, in this browser, within the
 * last five minutes (review round 2).
 *
 * ── Why the sign-in route needs one ──
 * `?org=` starts an organisation's single sign-on directly, so a link to it is
 * a login-CSRF primitive: an attacker who owns an organisation here, wired to
 * an identity provider they control, sends a victim to their `?org=` and the
 * victim comes back signed in as the attacker. Round 1 honoured `?org=` only
 * from a same-origin navigation — and review showed that a same-origin
 * navigation is something an attacker can arrange: the sign-in confirmation
 * redirected to the sealed `next`, which could itself be
 * `/api/auth/login?org=attacker-co`, so the victim's own truthful "Continue"
 * produced a perfectly same-origin request for the attacker's organisation.
 * Fetch metadata and `Referer` say where a request came from, not that a person
 * chose it. This token is what says that.
 *
 * ── What it is ──
 * The login route answers an `?org=` request that carries no valid token with
 * a 303 to `/sign-in?org=<slug>` — the page that names the organisation as the
 * unproven claim it is — and sets a random, `HttpOnly`, `__Host-` *binding*
 * cookie beside it. The page reads that cookie on the server and prints, into
 * its "Continue with single sign-on" link, an HMAC over the slug, the moment
 * and the binding. The login route honours `?org=` only with a token that
 * verifies against the cookie this browser presents, for that slug, under five
 * minutes old.
 *
 * ── Why bound to the browser ──
 * An HMAC over the slug and time alone would be minted by the page for
 * anybody who loads it — the attacker included, a second before they send the
 * link. Bound to the binding cookie, a token is good only in the browser that
 * was shown the page: the attacker's own token names the attacker's own
 * binding, and the victim's binding is `HttpOnly` and never leaves the
 * victim's browser except to this origin. The page is never framed
 * (`frame-ancestors 'none'`), and another origin cannot read it.
 *
 * Under the same operator secret as the state cookie, through its own HKDF
 * label, so neither cookie's MAC can stand in for this one. No database row: a
 * token is good for five minutes, and replaying one in the browser it was made
 * for only starts the same sign-in its own person already chose.
 */

/** `__Host-`, so a subdomain cannot plant or overwrite it. */
export const SSO_CONTINUE_COOKIE_NAME = '__Host-xecret_sso_continue';

/** How long a "Continue with single sign-on" link is good for, once the page printed it. */
export const SSO_CONTINUE_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * How long the binding cookie lives. Longer than a token, so a person who left
 * the page open past five minutes is bounced back to it once and handed a
 * fresh link, rather than to a page whose link can never work.
 */
export const SSO_CONTINUE_BINDING_TTL_SECONDS = 30 * 60;

const VERSION = 'k1';
const KEY_LABEL = 'xecret/sso-continue/v1';
const CLOCK_SKEW_SECONDS = 10;
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^k1\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

export type SsoContinueRejection =
  /** No token, or no binding cookie to check it against. */
  | 'missing'
  | 'malformed'
  /** Minted for another slug, another browser, or by something without the key. */
  | 'signature'
  | 'expired'
  | 'future';

export type SsoContinueResult = { ok: true } | { ok: false; reason: SsoContinueRejection };

/** The MAC key, from the operator secret, under this token's own label. */
export function deriveSsoContinueKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/** A fresh binding: 256 random bits, base64url. */
export function generateSsoContinueBinding(): string {
  return toBase64Url(randomBytes(32));
}

/** Whether a binding cookie's value is one {@link generateSsoContinueBinding} could have made. */
export function isWellFormedSsoContinueBinding(value: unknown): value is string {
  return typeof value === 'string' && BINDING_PATTERN.test(value);
}

/** `k1.<issuedAt>.<mac>`, for the warning page's "Continue" link. */
export async function mintSsoContinueToken(
  key: CryptoKey,
  params: { slug: string; binding: string; issuedAt: number },
): Promise<string> {
  if (!isSlug(params.slug) || !isWellFormedSsoContinueBinding(params.binding)) {
    throw new RangeError('A deep-link token needs a slug and a binding of the right shape.');
  }
  if (!Number.isSafeInteger(params.issuedAt) || params.issuedAt < 0) {
    throw new RangeError('A deep-link token needs an issue time in whole seconds.');
  }
  const mac = await crypto.subtle.sign('HMAC', key, macInput(params));
  return `${VERSION}.${params.issuedAt}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * Checks a token from the query string against the binding cookie this browser
 * presented, for the slug it asks for: shape first, then the MAC, then its age.
 */
export async function verifySsoContinueToken(
  key: CryptoKey,
  token: string | null | undefined,
  params: { slug: string; binding: string | null | undefined; now: Date },
): Promise<SsoContinueResult> {
  if (typeof token !== 'string' || token === '' || params.binding == null) {
    return { ok: false, reason: 'missing' };
  }
  const match = TOKEN_PATTERN.exec(token);
  if (match === null || !isSlug(params.slug) || !isWellFormedSsoContinueBinding(params.binding)) {
    return { ok: false, reason: 'malformed' };
  }
  const issuedAt = Number(match[1]);
  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = new Uint8Array(fromBase64Url(match[2] ?? ''));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (macBytes.length !== 32 || !Number.isSafeInteger(issuedAt)) {
    return { ok: false, reason: 'malformed' };
  }

  const authentic = await crypto.subtle.verify(
    'HMAC',
    key,
    macBytes,
    macInput({ slug: params.slug, binding: params.binding, issuedAt }),
  );
  if (!authentic) return { ok: false, reason: 'signature' };

  const nowSeconds = Math.floor(params.now.getTime() / 1000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'future' };
  if (nowSeconds - issuedAt > SSO_CONTINUE_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * The binding cookie's `Set-Cookie` value. `SameSite=Lax`: the bounce that
 * sets it may be the end of a navigation that began on another site — a link
 * in an email — and the warning page it lands on must still be able to read
 * it; `Lax` still withholds it from every cross-site subrequest and POST.
 */
export function ssoContinueCookie(binding: string): string {
  return [
    `${SSO_CONTINUE_COOKIE_NAME}=${binding}`,
    'Path=/',
    `Max-Age=${SSO_CONTINUE_BINDING_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Clears it — once a deep link it vouched for has been followed. */
export function clearedSsoContinueCookie(): string {
  return [
    `${SSO_CONTINUE_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** NUL-separated: none of the three parts can contain one, so no two inputs share a MAC input. */
function macInput(params: { slug: string; binding: string; issuedAt: number }) {
  return utf8Encode(
    `${VERSION}\u0000${params.slug}\u0000${params.binding}\u0000${params.issuedAt}`,
  );
}
