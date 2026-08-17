import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, firebaseAuthOrigin } from './csp';

/**
 * The policy is assembled rather than written down, so these are the tests for
 * an assembler: that the directives an injection would need are absent, that
 * the ones sign-in needs are present, and that a value taken from configuration
 * cannot become a second source expression.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name = '', ...sources] = part.split(' ');
      return [name, sources];
    }),
  );
}

const production = contentSecurityPolicy({
  isDevelopment: false,
  firebaseConfig: JSON.stringify({
    apiKey: 'k',
    authDomain: 'xecret-app.firebaseapp.com',
    projectId: 'p',
    appId: 'a',
  }),
});

/**
 * Every source a production policy may name, directive by directive.
 *
 * The `script-src` list came first, and it came from an incident. It began as an
 * assertion that no source in `script-src` started with `http`, which reads as
 * "no remote script host" and is not an invariant this application can hold —
 * `signInWithPopup` loads Google's script loader before it opens anything. So
 * the policy shipped without the allowance, Google sign-in could not work at
 * all, and the assertion stood over the hole looking like a security property.
 *
 * The other three directives were left to weaker checks, and a review showed
 * what that bought. `connect-src … https:`, `img-src … //evil.example` and
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
 */
const SCRIPT_SOURCES = [
  "'self'",
  "'unsafe-inline'",
  // The sign-in popup's loader.
  'https://apis.google.com',
  // reCAPTCHA Enterprise, which `signInWithEmailAndPassword`,
  // `createUserWithEmailAndPassword` and `sendPasswordResetEmail` all load by
  // themselves once an operator enables enforcement in the Firebase console.
  // Path-scoped because a bare `https://www.google.com` in `script-src` is a
  // known allowlist bypass; `csp.ts` has the trace.
  'https://www.google.com/recaptcha/',
  'https://www.gstatic.com/recaptcha/',
];

const CONNECT_SOURCES = [
  "'self'",
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://xecret-app.firebaseapp.com',
];

const IMG_SOURCES = ["'self'", 'data:', 'blob:'];

const FRAME_SOURCES = [
  "'self'",
  'https://xecret-app.firebaseapp.com',
  'https://www.google.com/recaptcha/',
];

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

  // The capability that reconstructs server stacks in the browser, and the one
  // an injected string most wants. A deployment shipping it would undo much of
  // the rest of this file.
  it('never hands a deployment `unsafe-eval`', () => {
    expect(production).not.toContain('unsafe-eval');
    expect(production).toContain('upgrade-insecure-requests');

    const development = contentSecurityPolicy({ isDevelopment: true, firebaseConfig: undefined });
    expect(development).toContain("'unsafe-eval'");
    // Every asset on a plain-http dev server would be unservable.
    expect(development).not.toContain('upgrade-insecure-requests');
  });
});

describe('the allowances sign-in needs', () => {
  it('names Google identity and the deployment own Firebase domain', () => {
    const connect = directives(production).get('connect-src') ?? [];

    expect(connect).toContain('https://identitytoolkit.googleapis.com');
    expect(connect).toContain('https://securetoken.googleapis.com');
    expect(connect).toContain('https://xecret-app.firebaseapp.com');
    // `signInWithPopup` keeps a hidden iframe on that host to hear the answer.
    expect(directives(production).get('frame-src')).toContain('https://xecret-app.firebaseapp.com');
  });

  // The step before the popup, and the one that was missing. `signInWithPopup`
  // initialises `browserPopupRedirectResolver` first, and that injects a
  // `<script>` for Google's loader; refused, the whole flow ends in
  // `auth/network-request-failed` before a window has opened.
  it('names the script loader the popup flow starts with', () => {
    expect(directives(production).get('script-src')).toContain('https://apis.google.com');

    // Google's, not the project's, so a deployment with no Firebase config
    // still gets the same policy rather than a differently-shaped one.
    const unconfigured = contentSecurityPolicy({
      isDevelopment: false,
      firebaseConfig: undefined,
    });
    expect(directives(unconfigured).get('script-src')).toContain('https://apis.google.com');
  });

  /**
   * The flows nobody thought were reCAPTCHA flows.
   *
   * `signInWithEmailAndPassword`, `createUserWithEmailAndPassword` and
   * `sendPasswordResetEmail` each go through `handleRecaptchaFlow(…,
   * EMAIL_PASSWORD_PROVIDER)` in `@firebase/auth`. The application constructs no
   * `RecaptchaVerifier` and never asks for any of this — one console toggle on
   * the Firebase side makes the SDK inject `enterprise.js`, which injects
   * `recaptcha__en.js` from gstatic, which embeds the badge frame. Refuse any of
   * the three and all three flows fail at once, with a generic message and
   * nothing in the repository to point at.
   *
   * Scoped to `/recaptcha/` rather than named as hosts, so this stays an
   * allowance for reCAPTCHA rather than for everything Google serves.
   */
  it('names the reCAPTCHA sources the email/password flows load by themselves', () => {
    const parsed = directives(production);

    expect(parsed.get('script-src')).toContain('https://www.google.com/recaptcha/');
    expect(parsed.get('script-src')).toContain('https://www.gstatic.com/recaptcha/');
    expect(parsed.get('frame-src')).toContain('https://www.google.com/recaptcha/');

    for (const source of parsed.get('script-src') ?? []) {
      if (
        source.startsWith('https://www.google.com') ||
        source.startsWith('https://www.gstatic.com')
      ) {
        expect(source, `${source} is not scoped to a path`).toMatch(/\/recaptcha\/$/);
      }
    }
  });

  // A self-hoster runs their own Firebase project. A hard-coded domain would
  // produce a policy that silently only permits sign-in to this deployment.
  it('follows the configured project rather than this one', () => {
    const other = contentSecurityPolicy({
      isDevelopment: false,
      firebaseConfig: JSON.stringify({ authDomain: 'acme-secrets.firebaseapp.com' }),
    });

    expect(other).toContain('https://acme-secrets.firebaseapp.com');
    expect(other).not.toContain('xecret-app');
  });

  // A deployment with no Firebase has no sign-in to break, and a malformed
  // value is reported by `check:env` with a better message than a CSP failure —
  // `parseFirebaseConfig` applies the same `isHostname` check this module
  // exports, so the two cannot disagree about what an `authDomain` is.
  it('builds without them rather than throwing', () => {
    for (const config of [undefined, '', 'not json', '[]', '{}', '{"authDomain":""}']) {
      const policy = contentSecurityPolicy({ isDevelopment: false, firebaseConfig: config });

      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain('https://identitytoolkit.googleapis.com');
      expect(policy).toContain("frame-src 'self'");
    }
  });
});

describe('a configured value cannot become a source expression', () => {
  // `authDomain` is operator-supplied, and it lands in the middle of a
  // space-separated list. A value carrying a space would otherwise add whatever
  // followed it as its own source — `evil.example https://*` is one directive
  // away from being the whole policy.
  it('refuses a domain that would smuggle in a second source', () => {
    for (const hostile of [
      'good.example https://evil.example',
      'good.example; script-src *',
      "good.example' 'unsafe-eval",
      'good.example/path',
      'good.example\nscript-src *',
    ]) {
      const origin = firebaseAuthOrigin(JSON.stringify({ authDomain: hostile }));

      // Either refused outright, or reduced to a single origin with no room
      // left for a delimiter.
      if (origin !== null) {
        expect(origin).toMatch(/^https:\/\/[^\s;'"*]+$/);
        expect(origin).toBe(new URL(origin).origin);
      }
    }
  });

  // What the assertion above never actually saw. Every hostile value fed to it
  // was malformed in a way `URL` happened to reject or flatten; a wildcard is
  // not malformed at all. `*` and `*.firebaseapp.com` are legal CSP host
  // sources meaning "anywhere" and "any subdomain", `new URL('https://*')`
  // parses happily, and its `.origin` is the wildcard right back — so the round
  // trip that was doing the vetting passed it straight through into
  // `connect-src`, which is the one directive whose entire value is that it
  // names somewhere specific.
  it('refuses a wildcard, which is a source expression rather than a host', () => {
    for (const wildcard of ['*', '*.firebaseapp.com', 'https://*', '*.*', 'a.*.example', '.']) {
      expect(
        firebaseAuthOrigin(JSON.stringify({ authDomain: wildcard })),
        `${wildcard} reached the policy`,
      ).toBeNull();
    }

    const policy = contentSecurityPolicy({
      isDevelopment: false,
      firebaseConfig: JSON.stringify({ authDomain: '*.firebaseapp.com' }),
    });

    // Built without the entries rather than with a permissive one: sign-in is
    // broken either way, and only one of the two is also a hole.
    expect(policy).toContain("frame-src 'self'");
    expect(policy).not.toContain('*');
  });

  // `HTTPS://P.FIREBASEAPP.COM` — a value that has been through something that
  // upper-cases environment variables. The scheme strip was case-sensitive, so
  // the scheme stayed on the front and was read as the hostname: the policy
  // named `https://https`, a well-formed source expression for a host nobody
  // owns, and sign-in failed with no directive obviously wrong.
  it('strips a scheme however it was capitalised', () => {
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'HTTPS://P.FIREBASEAPP.COM' }))).toBe(
      'https://p.firebaseapp.com',
    );
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'HtTp://p.firebaseapp.com' }))).toBe(
      'https://p.firebaseapp.com',
    );
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'P.FirebaseApp.com' }))).toBe(
      'https://p.firebaseapp.com',
    );
  });

  it('accepts the domain shapes a console actually gives', () => {
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'p.firebaseapp.com' }))).toBe(
      'https://p.firebaseapp.com',
    );
    // Pasted with the scheme already attached, which is the obvious mistake.
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'https://p.firebaseapp.com' }))).toBe(
      'https://p.firebaseapp.com',
    );
    expect(firebaseAuthOrigin(JSON.stringify({ authDomain: 'auth.example.co.uk' }))).toBe(
      'https://auth.example.co.uk',
    );
  });
});
