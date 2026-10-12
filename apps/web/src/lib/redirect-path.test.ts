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

  it('returns the parser’s reading of the path, not the string that went in', () => {
    // Dot segments are resolved, which can never climb above the origin.
    expect(safeRedirectPath('/a/../../b', '/fallback')).toBe('/b');
    // Characters a browser would escape anyway arrive escaped.
    expect(safeRedirectPath('/app?q=a b', '/fallback')).toBe('/app?q=a%20b');
  });
});
