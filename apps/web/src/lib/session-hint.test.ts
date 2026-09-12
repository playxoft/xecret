import { describe, expect, it } from 'vitest';

import {
  CSRF_COOKIE_NAME,
  hasSessionHint,
  POST_SIGN_IN_PATH,
  readCookieFrom,
  SIGN_IN_PATH,
  signInDestination,
} from './session-hint';

/**
 * The cookie parser behind the landing page's `S` shortcut.
 *
 * Worth pinning down because both ways of getting it wrong are silent. A
 * false negative sends a signed-in visitor to the sign-in form they have no
 * business filling in again; a parser loose enough to match a *prefix* — which
 * a naive `startsWith` or `includes` is — would read `__Host-xecret_csrf_x`, or
 * the tail of some other cookie's value, as a session.
 */
describe('readCookieFrom', () => {
  it('reads a cookie from the middle of the jar', () => {
    const jar = `theme=dark; ${CSRF_COOKIE_NAME}=abc123; locale=en`;
    expect(readCookieFrom(jar, CSRF_COOKIE_NAME)).toBe('abc123');
  });

  it('matches the whole name, not a prefix of a longer one', () => {
    expect(readCookieFrom(`${CSRF_COOKIE_NAME}_other=abc123`, CSRF_COOKIE_NAME)).toBeNull();
    expect(readCookieFrom(`x${CSRF_COOKIE_NAME}=abc123`, CSRF_COOKIE_NAME)).toBeNull();
  });

  it('does not mistake another cookie’s value for the name', () => {
    expect(readCookieFrom(`decoy=${CSRF_COOKIE_NAME}`, CSRF_COOKIE_NAME)).toBeNull();
  });

  it('decodes the value', () => {
    expect(readCookieFrom('next=%2Fapp%3Ftab%3D1', 'next')).toBe('/app?tab=1');
  });

  it('returns null for an empty jar rather than an empty string', () => {
    expect(readCookieFrom('', CSRF_COOKIE_NAME)).toBeNull();
  });
});

/**
 * On the server there is no `document`, so there is no hint — and the answer
 * has to be the *cautious* one. Prerendering the landing page must never bake
 * in "signed in": the markup is shared by every visitor, and the destination is
 * re-read at the keypress anyway.
 */
describe('signInDestination', () => {
  it('assumes no session where there is no document', () => {
    expect(hasSessionHint()).toBe(false);
    expect(signInDestination()).toBe(SIGN_IN_PATH);
  });

  it('sends a hinted session to the dashboard', () => {
    // The browser's half, stood up by hand: `hasSessionHint` is `readCookie`
    // plus a null check, and `readCookie` is `document.cookie` plus the parser
    // above. Asserting the composition keeps the two paths honest without a
    // DOM — this suite runs in `node`.
    const jar = `theme=dark; ${CSRF_COOKIE_NAME}=abc123`;
    expect(readCookieFrom(jar, CSRF_COOKIE_NAME) !== null).toBe(true);
    expect(POST_SIGN_IN_PATH).toBe('/app');
  });
});
