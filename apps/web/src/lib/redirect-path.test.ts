import { describe, expect, it } from 'vitest';

import { MAX_REDIRECT_PATH_LENGTH, safeRedirectPath } from './redirect-path';

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
