import { describe, expect, it } from 'vitest';

import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { authScreenHref, LOGIN_ROUTE, loginHref, ssoOrgParam } from './login-href';

/**
 * The query strings that carry `next` from a screen into `GET /api/auth/login`.
 *
 * What is pinned here is the round trip, not the spelling: whatever these
 * functions write, the login route must read back the destination that went in
 * — with `url.searchParams.get('next')`, which is what it does.
 */

const ORIGIN = 'https://xecret.test';

/** What `GET /api/auth/login` reads out of a link, the way it reads it. */
function readLoginLink(href: string): {
  path: string;
  next: string | null;
  hint: string | null;
  reauth: string | null;
} {
  const url = new URL(href, ORIGIN);
  return {
    path: url.pathname,
    next: url.searchParams.get('next'),
    hint: url.searchParams.get('hint'),
    reauth: url.searchParams.get('reauth'),
  };
}

/**
 * The consent screen `xecret login` opens, with the characters most likely to
 * be mangled on the way through: an encoded apostrophe and spaces in the device
 * name, an encoded `+` and `=` in the opaque state, and `&` between every pair.
 */
const CLI_AUTHORIZE =
  '/cli/authorize?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&port=52310' +
  '&device=Nitheesh%27s%20MacBook%20Pro&state=a%2Bb%3Dc';

describe('loginHref', () => {
  it('omits `next` when it is the default destination', () => {
    expect(loginHref()).toBe(LOGIN_ROUTE);
    expect(loginHref({ next: POST_SIGN_IN_PATH })).toBe(LOGIN_ROUTE);
    expect(loginHref({ next: null })).toBe(LOGIN_ROUTE);
  });

  it('omits a `next` that normalises to the default', () => {
    // An empty query is still `/app`; it should not earn a parameter.
    expect(loginHref({ next: `${POST_SIGN_IN_PATH}?` })).toBe(LOGIN_ROUTE);
  });

  it('drops a `next` that is not a same-origin path rather than forwarding it', () => {
    for (const hostile of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      expect(readLoginLink(loginHref({ next: hostile })).next).toBeNull();
    }
  });

  it.each([
    ['a dashboard path', '/app/acme/api/production'],
    ['a query and a fragment', '/app/acme/api/production?tab=history#row-3'],
    ['a literal plus sign', '/app/acme?q=a+b'],
    ['an already-escaped value', '/app/acme?q=a%26b%3Dc'],
    ['the CLI consent screen', CLI_AUTHORIZE],
  ])('carries %s through to the login route intact', (_label, next) => {
    expect(readLoginLink(loginHref({ next })).next).toBe(next);
  });

  it('asks for the sign-up screen only when told to', () => {
    expect(readLoginLink(loginHref()).hint).toBeNull();
    expect(readLoginLink(loginHref({ signUp: true }))).toEqual({
      path: LOGIN_ROUTE,
      next: null,
      hint: 'sign-up',
      reauth: null,
    });
    expect(readLoginLink(loginHref({ signUp: true, next: CLI_AUTHORIZE }))).toEqual({
      path: LOGIN_ROUTE,
      next: CLI_AUTHORIZE,
      hint: 'sign-up',
      reauth: null,
    });
  });

  it('carries an SSO deep link for a slug, and nothing that is not one', () => {
    const href = loginHref({ org: 'acme-corp', next: '/app/acme-corp' });
    const url = new URL(href, ORIGIN);
    expect(url.pathname).toBe(LOGIN_ROUTE);
    expect(url.searchParams.get('org')).toBe('acme-corp');
    expect(url.searchParams.get('next')).toBe('/app/acme-corp');

    for (const hostile of ['Acme', 'acme corp', '<script>', '-acme', 'a'.repeat(200)]) {
      expect(new URL(loginHref({ org: hostile }), ORIGIN).searchParams.has('org')).toBe(false);
    }
    // A deep link is about an organisation; a re-authentication and a sign-up are not.
    expect(new URL(loginHref({ org: 'acme', reauth: true }), ORIGIN).searchParams.has('org')).toBe(
      false,
    );
    expect(new URL(loginHref({ org: 'acme', signUp: true }), ORIGIN).searchParams.has('org')).toBe(
      false,
    );
  });

  it('carries the warning page’s continue token beside a deep link, and only beside one', () => {
    const token = 'k1.1790000000.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const url = new URL(loginHref({ org: 'acme', continueToken: token }), ORIGIN);
    expect(url.searchParams.get('org')).toBe('acme');
    expect(url.searchParams.get('continue')).toBe(token);

    for (const options of [
      { continueToken: token },
      { continueToken: token, reauth: true, org: 'acme' },
      { continueToken: token, signUp: true, org: 'acme' },
      { continueToken: token, org: 'Not A Slug' },
      { continueToken: '', org: 'acme' },
      { continueToken: null, org: 'acme' },
    ]) {
      expect(new URL(loginHref(options), ORIGIN).searchParams.has('continue')).toBe(false);
    }
  });

  it('never carries an API route as next (review round 2)', () => {
    expect(readLoginLink(loginHref({ next: '/api/auth/login?org=attacker-co' })).next).toBeNull();
  });

  it('forces a re-authentication, and never pairs one with the sign-up hint', () => {
    expect(
      readLoginLink(loginHref({ reauth: true, signUp: true, next: '/app/settings/security' })),
    ).toEqual({
      path: LOGIN_ROUTE,
      next: '/app/settings/security',
      hint: null,
      reauth: '1',
    });
  });
});

describe('ssoOrgParam', () => {
  it('accepts a slug the sign-in page may print, and nothing else', () => {
    expect(ssoOrgParam('acme')).toBe('acme');
    expect(ssoOrgParam('acme-2')).toBe('acme-2');
    for (const hostile of [
      null,
      '',
      'Acme',
      'acme corp',
      'acme--corp',
      '<b>x</b>',
      'a'.repeat(200),
    ]) {
      expect(ssoOrgParam(hostile)).toBeNull();
    }
  });
});

describe('authScreenHref', () => {
  it('links the two screens without a parameter in the common case', () => {
    expect(authScreenHref('/sign-up')).toBe('/sign-up');
    expect(authScreenHref('/sign-in', POST_SIGN_IN_PATH)).toBe('/sign-in');
  });

  it('keeps `next` when crossing from one screen to the other', () => {
    const href = authScreenHref('/sign-up', CLI_AUTHORIZE);
    const url = new URL(href, ORIGIN);
    expect(url.pathname).toBe('/sign-up');
    expect(url.searchParams.get('next')).toBe(CLI_AUTHORIZE);
  });
});

/**
 * `xecret login`, end to end through the browser half.
 *
 * The CLI opens the consent screen without a session; `GET /api/auth/me`
 * answers 401; `lib/api.ts` (`redirectToSignIn`) sends the tab to
 * `/sign-in?next=<encodeURIComponent of path, query and hash>`; Next decodes
 * the parameter into `searchParams`; the page validates it and builds the
 * button; the login route reads it back and validates it again before sealing
 * it into the state cookie the callback redirects from. Every step is
 * reproduced here with the code or the parser that performs it, and the path
 * that comes out must be the one that went in — or the consent screen comes
 * back without the port the CLI is listening on.
 */
describe('the CLI login round trip', () => {
  it('returns the consent screen with its whole query string', () => {
    // lib/api.ts, `redirectToSignIn`.
    const bounced = `/sign-in?next=${encodeURIComponent(CLI_AUTHORIZE)}`;
    // Next's `searchParams`, then the sign-in page.
    const received = new URL(bounced, ORIGIN).searchParams.get('next');
    const validated = safeRedirectPath(received, POST_SIGN_IN_PATH);
    // The button the page renders, then the login route.
    const href = loginHref({ next: validated });
    const sealed = safeRedirectPath(readLoginLink(href).next, POST_SIGN_IN_PATH);

    expect(sealed).toBe(CLI_AUTHORIZE);
  });

  it('survives a detour through the sign-up screen', () => {
    const viaSignUp = authScreenHref('/sign-up', CLI_AUTHORIZE);
    const received = new URL(viaSignUp, ORIGIN).searchParams.get('next');
    const href = loginHref({ signUp: true, next: safeRedirectPath(received, POST_SIGN_IN_PATH) });

    expect(safeRedirectPath(readLoginLink(href).next, POST_SIGN_IN_PATH)).toBe(CLI_AUTHORIZE);
  });
});
