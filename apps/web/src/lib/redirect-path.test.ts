import { describe, expect, it } from 'vitest';

import { MAX_REDIRECT_PATH_LENGTH, safePostSignInPath, safeRedirectPath } from './redirect-path';

/**
 * `?next=` is attacker-supplied and, since WorkOS, it is also what the sign-in
 * callback redirects to — through a signed cookie, but the cookie only carries
 * what this function let through. Each refusal below is a known open-redirect
 * bypass.
 */
describe('safeRedirectPath', () => {
  it.each([
    ['/app', '/app'],
    ['/app/acme/api/production?tab=history#row-3', '/app/acme/api/production?tab=history#row-3'],
    // The CLI consent screen: the longest legitimate `next` there is.
    [
      '/cli/authorize?challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&port=50123&device=My%20Laptop&state=s1',
      '/cli/authorize?challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&port=50123&device=My%20Laptop&state=s1',
    ],
  ])('keeps a same-origin path: %s', (value, expected) => {
    expect(safeRedirectPath(value, '/fallback')).toBe(expected);
  });

  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash-relative URL', '/\\evil.example'],
    ['a backslash later in the path', '/app\\..\\evil'],
    ['a relative path', 'app'],
    ['javascript:', 'javascript:alert(1)'],
    // The parser strips these before it reads anything, so a single leading
    // slash becomes two: `/\t/evil.example` is `//evil.example`.
    ['a tab after the slash', '/\t/evil.example'],
    ['a newline after the slash', '/\n/evil.example'],
    ['a carriage return after the slash', '/\r/evil.example'],
    ['a NUL', '/app\u0000'],
    ['DEL', '/app\u007f'],
    ['an over-long path', `/${'a'.repeat(MAX_REDIRECT_PATH_LENGTH)}`],
  ])('refuses %s', (_label, value) => {
    expect(safeRedirectPath(value, '/fallback')).toBe('/fallback');
  });

  it.each([
    // Each passes every rule as typed, resolves on the right origin, and
    // normalises to a protocol-relative `//evil.example` — the round-1 finding.
    ['a dot segment before a double slash', '/.//evil.example/phish'],
    ['a parent segment before a double slash', '/..//evil.example'],
    ['an encoded dot segment', '/%2e//evil.example'],
    ['an encoded dot segment, upper case', '/%2E//evil.example'],
    ['a climb out of a real segment', '/app/..//evil.example'],
    ['two climbs', '/a/b/../..//evil.example'],
    ['a dot segment, then a query', '/.//evil.example?x=1'],
  ])('refuses %s, which normalises to a protocol-relative URL', (_label, value) => {
    expect(safeRedirectPath(value, '/fallback')).toBe('/fallback');
  });

  it.each([
    // Review round 2: a same-origin `next` that is an API route turns the
    // sign-in confirmation's "Continue" into a same-origin GET the route acts
    // on — `/api/auth/login?org=attacker-co` above all.
    ['the SSO deep link itself', '/api/auth/login?org=attacker-co'],
    ['any API route', '/api/orgs/acme'],
    ['the API root', '/api'],
    ['the API root with a query', '/api?x=1'],
    ['upper case', '/API/auth/login?org=attacker-co'],
    ['mixed case', '/Api/Auth/Login'],
    ['an encoded letter', '/%61pi/auth/login?org=attacker-co'],
    ['an encoded slash', '/api%2Fauth%2Flogin'],
    ['an encoded slash before it', '/%2Fapi/auth/login'],
    ['double encoding', '/%2561pi/auth/login'],
    ['an encoded backslash', '/api%5Cauth%5Clogin'],
    ['a climb into it', '/app/../api/auth/login'],
    ['an encoded climb into it', '/app/%2e%2e/api/auth/login'],
    ['a double-encoded climb into it', '/app/%252e%252e/api/auth/login'],
    ['repeated slashes inside', '/app/..//api/x'],
    ['an undecodable path', '/api/%zz'],
  ])('refuses %s under /api/', (_label, value) => {
    expect(safeRedirectPath(value, '/fallback')).toBe('/fallback');
  });

  it.each([
    // Real pages, including ones whose names merely contain "api".
    ['/app/acme/api/production'],
    ['/apiary'],
    ['/docs/api/reference'],
    ['/cli/authorize?challenge=abc&port=50123'],
    ['/invite/xit_live_abc'],
    ['/sign-in?org=acme'],
  ])('keeps a page that is not an API route: %s', (value) => {
    expect(safeRedirectPath(value, '/fallback')).toBe(value);
  });

  it('returns a fixed point: whatever it returns, it returns unchanged when given it again', () => {
    for (const value of [
      '/app',
      '/app?',
      '/a/../b',
      '/a/./b//c',
      '/app?q=a b#h',
      '/%2e%2e/x',
      '/cli/authorize?challenge=abc&port=50123&device=My%20Laptop',
    ]) {
      const once = safeRedirectPath(value, '/fallback');
      expect(safeRedirectPath(once, '/other')).toBe(once);
    }
  });

  it('never yields an off-origin destination under a random walk of path atoms', () => {
    // The reviewer's fuzz, kept: 20 000 random inputs from the atoms that make
    // dot-segment and slash tricks, each resolved the way a browser resolves a
    // Location header against the callback's URL. (The reviewer ran 300 000
    // against the fix; this keeps a slice of it in the suite.)
    const atoms = [
      '/',
      '/',
      '.',
      '..',
      '%2e',
      '%2E',
      'a',
      'evil.example',
      '?',
      '#',
      '@',
      ':',
      '%2f',
      '%09',
      ';',
      '//',
      '/./',
    ];
    let seed = 0x2545f491;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const offOrigin: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      let value = '/';
      const length = 1 + Math.floor(random() * 7);
      for (let j = 0; j < length; j += 1) value += atoms[Math.floor(random() * atoms.length)];
      const out = safeRedirectPath(value, '/app');
      const landed = new URL(out, 'https://xecret.example/api/auth/callback');
      if (landed.origin !== 'https://xecret.example' || out.startsWith('//')) offOrigin.push(value);
      expect(safeRedirectPath(out, '/other')).toBe(out);
    }
    expect(offOrigin).toEqual([]);
  });

  it('returns the parser’s reading of the path, not the string that went in', () => {
    // Dot segments are resolved, which can never climb above the origin.
    expect(safeRedirectPath('/a/../../b', '/fallback')).toBe('/b');
    // Characters a browser would escape anyway arrive escaped.
    expect(safeRedirectPath('/app?q=a b', '/fallback')).toBe('/app?q=a%20b');
  });
});

/**
 * Where a completed sign-in may land (review round 3): everything
 * `safeRedirectPath` refuses, and the sign-in screens too — a finished sign-in
 * chained onto the SSO warning page reads as the second step of what the person
 * just did.
 */
describe('safePostSignInPath', () => {
  it.each([
    ['the SSO warning page', '/sign-in?org=attacker-co'],
    ['the sign-in page', '/sign-in'],
    ['the sign-up page', '/sign-up?org=attacker-co'],
    // Next's permanent redirects to /sign-in carry the query across.
    ['the old password-reset request page', '/forgot-password?org=attacker-co'],
    ['the old password-reset link', '/reset-password?mode=resetPassword&org=attacker-co'],
    ['the confirmation page', '/sign-in/confirm'],
    ['a trailing slash', '/sign-in/?org=attacker-co'],
    ['upper case', '/SIGN-IN?org=attacker-co'],
    ['mixed case', '/Forgot-Password?org=attacker-co'],
    ['an encoded letter', '/%73ign-in?org=attacker-co'],
    ['double encoding', '/%2573ign-in?org=attacker-co'],
    ['an encoded query', '/sign-in%3Forg%3Dattacker-co'],
    ['a climb into it', '/app/../sign-in?org=attacker-co'],
    ['an encoded climb into it', '/app/%2e%2e/forgot-password?org=attacker-co'],
    ['a dot segment', '/./sign-in?org=attacker-co'],
    ['an encoded slash', '/sign-in%2Fconfirm'],
  ])('refuses %s', (_label, value) => {
    expect(safePostSignInPath(value, '/fallback')).toBe('/fallback');
  });

  it.each([
    ['an API route', '/api/auth/login?org=attacker-co'],
    ['a protocol-relative URL', '//evil.example'],
    ['a dot segment before a double slash', '/.//evil.example'],
  ])('refuses everything safeRedirectPath refuses: %s', (_label, value) => {
    expect(safePostSignInPath(value, '/fallback')).toBe('/fallback');
  });

  it.each([
    ['/app'],
    ['/app/acme/sign-in'],
    ['/sign-inside'],
    ['/docs/sign-in'],
    ['/invite/xit_live_abc'],
    [
      '/cli/authorize?challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&port=50123&device=My%20Laptop&state=s1',
    ],
  ])('keeps a page that is not a sign-in screen: %s', (value) => {
    expect(safePostSignInPath(value, '/fallback')).toBe(value);
  });

  it('leaves safeRedirectPath alone: the warning page is still a page people are sent to', () => {
    expect(safeRedirectPath('/sign-in?org=acme', '/fallback')).toBe('/sign-in?org=acme');
  });

  it('answers the fallback for nothing at all', () => {
    expect(safePostSignInPath(null, '/app')).toBe('/app');
    expect(safePostSignInPath(undefined, '/app')).toBe('/app');
  });
});
