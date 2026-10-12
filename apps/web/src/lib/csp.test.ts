import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from './csp';

/**
 * The policy is assembled rather than written down, so these are the tests for
 * an assembler: that the directives an injection would need are absent, that
 * nothing sign-in no longer needs has crept back, and that development's one
 * extra allowance stays in development.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name = '', ...sources] = part.split(' ');
      return [name, sources];
    }),
  );
}

const production = contentSecurityPolicy({ isDevelopment: false });
const development = contentSecurityPolicy({ isDevelopment: true });

/**
 * Every source a production policy may name, directive by directive.
 *
 * The `script-src` list came first, and it came from an incident. It began as an
 * assertion that no source in `script-src` started with `http`, which read as
 * "no remote script host" and was not an invariant the application could then
 * hold — the Firebase popup loaded Google's script loader before it opened
 * anything. So the policy shipped without the allowance, Google sign-in could
 * not work at all, and the assertion stood over the hole looking like a security
 * property.
 *
 * The other directives were left to weaker checks, and a review showed what that
 * bought. `connect-src … https:`, `img-src … //evil.example` and
 * `frame-src … https://evil.example` could each be added to `csp.ts` with the
 * whole suite still green: `not.toContain('*')` is an exact-element match, so a
 * scheme-only source walks past it, and `startsWith('http')` does not see a
 * scheme-relative host at all. `csp.ts` opens by promising a policy that leaves
 * exfiltration nowhere to go, and the tests under it could not tell that policy
 * apart from its opposite.
 *
 * So the invariant for each is that the set is *this* set, keywords included.
 * Filtering the quoted sources out and checking only the hosts is how
 * `'strict-dynamic'` gets in — a keyword that makes browsers ignore every host
 * beside it. Adding a source is a deliberate edit in two places rather than a
 * silent widening in one.
 *
 * Since sign-in moved to WorkOS, the "no remote script host" invariant that was
 * wrong then is right now, and is held: the browser only *navigates* to
 * AuthKit, so no directive names a host — WorkOS's or anybody else's. The
 * Google identity endpoints, Google's script loader, the Firebase auth domain
 * and reCAPTCHA's script and frame sources are all gone, and the sets below are
 * what is left.
 */
const SCRIPT_SOURCES = ["'self'", "'unsafe-inline'"];
const CONNECT_SOURCES = ["'self'"];
const IMG_SOURCES = ["'self'", 'data:', 'blob:'];
const FRAME_SOURCES = ["'self'"];

/**
 * The whole production policy, every directive and every source, in order.
 *
 * The per-directive sets above say why each matters; this says nothing else is
 * there. A directive *removed* is as much a widening as a source added —
 * dropping `object-src` hands its job to `default-src`, dropping
 * `frame-ancestors` re-opens clickjacking — and neither shows up in an
 * assertion about the directives that remain.
 */
const PRODUCTION_POLICY = new Map<string, string[]>([
  ['default-src', ["'self'"]],
  ['script-src', SCRIPT_SOURCES],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', IMG_SOURCES],
  ['font-src', ["'self'"]],
  ['connect-src', CONNECT_SOURCES],
  ['frame-src', FRAME_SOURCES],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['form-action', ["'self'"]],
  ['frame-ancestors', ["'none'"]],
  ['worker-src', ["'self'", 'blob:']],
  ['manifest-src', ["'self'"]],
  ['upgrade-insecure-requests', []],
]);

/** Every `directive source` pair in a policy, flattened. */
function everySource(policy: string): Array<{ directive: string; source: string }> {
  return [...directives(policy)].flatMap(([directive, sources]) =>
    sources.map((source) => ({ directive, source })),
  );
}

/**
 * `https:`, `data:`, `ws:` — a scheme with nothing after it, which permits every
 * origin reachable over that scheme. It is a legal source expression, it
 * contains no wildcard, and it does not begin with `http`, so it is what walked
 * past the checks this file used to make.
 */
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:$/i;

/**
 * The two scheme-only sources that are deliberately here, and the only
 * directives allowed to carry them.
 *
 * Neither names a remote origin, which is why they are not exfiltration; but
 * `data:` in `script-src` would be a hole large enough to drive an injection
 * through, so where they appear is checked rather than assumed.
 */
const NON_NETWORK_SCHEMES = new Map([
  ['data:', ['img-src']],
  ['blob:', ['img-src', 'worker-src']],
]);

/** A CSP keyword: `'self'`, `'none'`, `'unsafe-inline'` and the like. */
const KEYWORD = /^'[a-z-]+'$/;

describe('the policy an injection runs into', () => {
  // The payload the docs-renderer review actually demonstrated. Script
  // execution is not what this policy stops — the RSC flight payload is inline
  // and unhashable — so the whole of its value is that the stolen value has
  // nowhere to go.
  it('gives exfiltration nowhere to send anything', () => {
    const parsed = directives(production);

    expect(parsed.get('connect-src')).toEqual(CONNECT_SOURCES);
    expect(parsed.get('img-src')).toEqual(IMG_SOURCES);
    expect(parsed.get('form-action')).toEqual(["'self'"]);
  });

  /**
   * The net under the enumerations above, and the one that would have caught
   * the mutations the review demonstrated even if nobody had thought to write a
   * list for the directive in question.
   */
  it('never names a source that quietly means "anywhere"', () => {
    for (const { directive, source } of everySource(production)) {
      const where = `${directive} ${source}`;

      // A substring check, not an element match: `*`, `*.evil.example`,
      // `https://*` and `https://*.evil.example` are all the same mistake.
      expect(source, where).not.toContain('*');
      // Scheme-relative. Inherits the page's scheme and is a host source in
      // every other respect, so nothing that looks for `http` finds it.
      expect(source, where).not.toMatch(/^\/\//);
      // Would let a network attacker on a coffee-shop wifi supply the response,
      // which no allowance in this policy is worth.
      expect(source, where).not.toMatch(/^http:\/\//);
      // Makes a browser ignore every host named beside it, so it would undo the
      // enumerations above without removing a line from them.
      expect(source, where).not.toBe("'strict-dynamic'");
      expect(source, where).not.toBe("'unsafe-eval'");

      if (SCHEME_ONLY.test(source)) {
        expect(NON_NETWORK_SCHEMES.get(source) ?? [], where).toContain(directive);
      }
    }
  });

  /**
   * Stronger than the net above, and only possible since sign-in stopped
   * running in the browser: no directive names a host at all. Every source is
   * a keyword or one of the two non-network schemes, so there is no third-party
   * origin for an injected script to reach through — not even one that was
   * allowed for a good reason.
   */
  it('names no host, so there is no third party to reach through', () => {
    for (const { directive, source } of everySource(production)) {
      const allowed = KEYWORD.test(source) || NON_NETWORK_SCHEMES.has(source);
      expect(allowed, `${directive} ${source} names an origin`).toBe(true);
    }
  });

  it('refuses a second stage, a rewritten base and the plugin vectors', () => {
    const parsed = directives(production);

    // Sources are exactly the enumerated ones, keywords included — so a second
    // stage still has nowhere to be loaded from, and an origin quietly added to
    // the directive shows up here rather than in production.
    expect(parsed.get('script-src')).toEqual(SCRIPT_SOURCES);
    expect(parsed.get('frame-src')).toEqual(FRAME_SOURCES);

    expect(parsed.get('base-uri')).toEqual(["'self'"]);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('closes over every directive it does not name', () => {
    expect(directives(production).get('default-src')).toEqual(["'self'"]);
  });

  it('is exactly this policy: no directive added, dropped or widened', () => {
    expect(directives(production)).toEqual(PRODUCTION_POLICY);
  });

  // The capability that reconstructs server stacks in the browser, and the one
  // an injected string most wants. A deployment shipping it would undo much of
  // the rest of this file.
  it('never hands a deployment `unsafe-eval`', () => {
    expect(production).not.toContain('unsafe-eval');
    expect(production).toContain('upgrade-insecure-requests');

    expect(development).toContain("'unsafe-eval'");
    // Every asset on a plain-http dev server would be unservable.
    expect(development).not.toContain('upgrade-insecure-requests');
  });

  // The flag is a switch for exactly two things. If development grew a third
  // difference, `next dev` would be testing a policy production never serves.
  it('differs in development by `unsafe-eval` and the upgrade, and nothing else', () => {
    const expected = new Map(PRODUCTION_POLICY);
    expected.set('script-src', [...SCRIPT_SOURCES, "'unsafe-eval'"]);
    expected.delete('upgrade-insecure-requests');

    expect(directives(development)).toEqual(expected);
  });
});

describe('signing in, which asks nothing of the policy', () => {
  /**
   * The redirect flow's whole effect on the policy: none. The browser follows a
   * link to `GET /api/auth/login`, is redirected to AuthKit, and is redirected
   * back to `GET /api/auth/callback`. Those are top-level navigations, which no
   * directive here governs; the code exchange is a call the server makes. A
   * WorkOS host appearing in the policy would be an allowance for something the
   * browser never does — exactly the kind of source an injected script could
   * use and nothing else would.
   */
  it('names no identity provider, current or former', () => {
    for (const { directive, source } of everySource(production)) {
      expect(source, `${directive} ${source}`).not.toMatch(
        /workos|authkit|google|gstatic|firebase/i,
      );
    }
  });

  /**
   * Why the way into AuthKit is a link. `form-action` is applied to every
   * redirect a form submission follows, not only to its `action`, so a form
   * posting to the login route would have the 307 to AuthKit refused here. The
   * answer to that is the link, never a WorkOS host in this directive — which
   * would also let an injected form post the page's contents there.
   */
  it('keeps form submissions to this origin, which is why sign-in is a link', () => {
    expect(directives(production).get('form-action')).toEqual(["'self'"]);
    expect(directives(development).get('form-action')).toEqual(["'self'"]);
  });
});
