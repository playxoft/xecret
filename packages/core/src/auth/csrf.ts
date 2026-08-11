import { randomBytes, timingSafeEqual, toBase64Url, utf8Encode } from '../crypto/encoding';

/**
 * CSRF protection for cookie-authenticated mutations.
 *
 * `SameSite=Lax` already blocks the classic cross-site form POST, so this is
 * defence in depth rather than the only control. It matters because `Lax` is a
 * browser behaviour we do not control: older browsers, and any future relaxation
 * of the rules, would otherwise leave mutations exposed.
 *
 * Double-submit cookie pattern: the token is sent both as a readable cookie and
 * as a request header. An attacker on another origin can cause the cookie to be
 * sent, but cannot read it to set the matching header.
 *
 * Bearer-token requests (CLI, CI) do not need this and must not require it —
 * they carry no ambient cookie, so there is nothing for a browser to attach
 * automatically.
 */

export const CSRF_COOKIE_NAME = '__Host-xecret_csrf';
export const CSRF_HEADER_NAME = 'x-xecret-csrf';

/** Methods that may not change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken(): string {
  return toBase64Url(randomBytes(32));
}

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export type CsrfRejection = 'missing-cookie' | 'missing-header' | 'mismatch';

export type CsrfResult = { ok: true } | { ok: false; reason: CsrfRejection };

/**
 * Verifies the double-submit pair.
 *
 * Compared in constant time: a short-circuiting comparison would let an attacker
 * who can observe request timing discover the token one byte at a time.
 */
export function verifyCsrf(cookieToken: string | null, headerToken: string | null): CsrfResult {
  if (!cookieToken) return { ok: false, reason: 'missing-cookie' };
  if (!headerToken) return { ok: false, reason: 'missing-header' };

  const matches = timingSafeEqual(utf8Encode(cookieToken), utf8Encode(headerToken));
  return matches ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * The CSRF cookie is deliberately readable by JavaScript — the client must send
 * its value back in a header, which is the whole mechanism. It carries no
 * authority on its own: it is worthless without the HttpOnly session cookie.
 */
export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${CSRF_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
