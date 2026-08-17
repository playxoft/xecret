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

describe('the policy an injection runs into', () => {
  // The payload the docs-renderer review actually demonstrated. Script
  // execution is not what this policy stops — the RSC flight payload is inline
  // and unhashable — so the whole of its value is that the stolen value has
  // nowhere to go.
  it('gives exfiltration nowhere to send anything', () => {
    const parsed = directives(production);

    expect(parsed.get('connect-src')).not.toContain('*');
    expect(parsed.get('connect-src')?.[0]).toBe("'self'");
    expect(parsed.get('img-src')).not.toContain('*');
    expect(parsed.get('img-src')?.some((source) => source.startsWith('http'))).toBe(false);
    expect(parsed.get('form-action')).toEqual(["'self'"]);
  });

  it('refuses a second stage, a rewritten base and the plugin vectors', () => {
    const parsed = directives(production);

    expect(parsed.get('script-src')?.some((source) => source.startsWith('http'))).toBe(false);
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
  // value is reported by `check:env` with a better message than a CSP failure.
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
