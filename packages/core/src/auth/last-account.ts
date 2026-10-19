import { fromBase64Url, toBase64Url, utf8Encode } from '../crypto/encoding';
import { deriveCookieKey } from './oauth-state';

/**
 * Which account last signed in on this browser — the signed, `HttpOnly`
 * cookie that lets a returning person past the reused-session confirmation
 * (review round 2).
 *
 * ── Why ──
 * The sign-in callback holds back a sign-in WorkOS answered from an
 * authentication that predates the flow — a session AuthKit reused without
 * asking — because that is the signature of a planted AuthKit session: the
 * attacker's, answering the victim's next "Sign in". But a person whose own
 * xecret session expired, while AuthKit still held theirs, looks exactly the
 * same, and being asked "Is this you?" on nearly every return teaches people to
 * click "Continue" without reading — the one habit the confirmation cannot
 * survive.
 *
 * So the callback skips *that* question — and only that one — when the account
 * the reused session resolves to is the account this browser last signed in
 * as. A planted session is always somebody else's account, so it is still held
 * back. A sign-in through an organisation the flow did not ask for, or one the
 * account is not a member of, is held back whatever this cookie says.
 *
 * ── What it is ──
 * `a1.<user id>.<mac>`: an HMAC, under its own HKDF label of the same operator
 * secret, over the account id. Not a credential — it signs nobody in and opens
 * nothing; the most a stolen one does is spare the account it names one
 * question in a browser that already reached WorkOS as that account. Written
 * by the response that issues a session, and kept across sign-out on purpose:
 * "the last account on this browser" is what it means.
 */

/** `__Host-`, so a subdomain cannot plant or overwrite it. */
export const LAST_ACCOUNT_COOKIE_NAME = '__Host-xecret_last_account';

/** Half a year. A browser caps a cookie's life at around 400 days anyway. */
export const LAST_ACCOUNT_TTL_SECONDS = 180 * 24 * 60 * 60;

const VERSION = 'a1';
const KEY_LABEL = 'xecret/last-account/v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The MAC key, from the operator secret, under this cookie's own label. */
export function deriveLastAccountKey(secret: string): Promise<CryptoKey> {
  return deriveCookieKey(secret, KEY_LABEL);
}

/** `a1.<user id>.<mac>`. */
export async function sealLastAccount(key: CryptoKey, userId: string): Promise<string> {
  if (!UUID_PATTERN.test(userId)) throw new RangeError('An account id is a lower-case UUID.');
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`${VERSION}.${userId}`));
  return `${VERSION}.${userId}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The account a cookie names, or `null` for anything this module did not write. */
export async function openLastAccount(
  key: CryptoKey,
  cookie: string | null | undefined,
): Promise<string | null> {
  if (typeof cookie !== 'string' || cookie.length > 256) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, userId = '', mac = ''] = parts;
  if (!UUID_PATTERN.test(userId)) return null;

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = new Uint8Array(fromBase64Url(mac));
  } catch {
    return null;
  }
  if (macBytes.length !== 32) return null;
  const authentic = await crypto.subtle.verify(
    'HMAC',
    key,
    macBytes,
    utf8Encode(`${VERSION}.${userId}`),
  );
  return authentic ? userId : null;
}

/**
 * The `Set-Cookie` value. `SameSite=Lax`: the callback that reads it is a
 * cross-site top-level navigation back from WorkOS, which `Strict` would strip
 * it from.
 */
export function lastAccountCookie(value: string): string {
  return [
    `${LAST_ACCOUNT_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${LAST_ACCOUNT_TTL_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
