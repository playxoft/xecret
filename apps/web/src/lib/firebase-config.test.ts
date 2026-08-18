import { describe, expect, it } from 'vitest';
import { parseFirebaseConfig } from './firebase';

/**
 * The Firebase web config arrives as one JSON blob that a human pastes out of
 * the Firebase console. Everything below is a way that paste goes wrong.
 *
 * Each failure has to name what is actually wrong, because the person reading
 * it is a self-hoster on their first run. "Firebase is not configured" sends
 * them looking for a missing project; "missing appId" sends them back to the
 * console tab they already have open.
 */

const VALID = JSON.stringify({
  apiKey: 'AIzaSyExample',
  authDomain: 'xecret-demo.firebaseapp.com',
  projectId: 'xecret-demo',
  appId: '1:1234567890:web:abcdef',
});

function problemOf(raw: string | undefined): string {
  const result = parseFirebaseConfig(raw);
  if (!('problem' in result)) throw new Error('expected the config to be rejected');
  return result.problem;
}

describe('a well-formed config', () => {
  it('is accepted and mapped onto the SDK’s shape', () => {
    expect(parseFirebaseConfig(VALID)).toEqual({
      config: {
        apiKey: 'AIzaSyExample',
        authDomain: 'xecret-demo.firebaseapp.com',
        projectId: 'xecret-demo',
        appId: '1:1234567890:web:abcdef',
      },
    });
  });

  // The console's snippet carries measurementId, storageBucket and more. A
  // paste must not be rejected for containing exactly what was copied.
  it('ignores the extra fields the Firebase console includes', () => {
    const withExtras = JSON.stringify({
      ...(JSON.parse(VALID) as Record<string, string>),
      storageBucket: 'xecret-demo.appspot.com',
      messagingSenderId: '1234567890',
      measurementId: 'G-ABCDEF',
    });

    const result = parseFirebaseConfig(withExtras);
    expect('config' in result && Object.keys(result.config)).toEqual([
      'apiKey',
      'authDomain',
      'projectId',
      'appId',
    ]);
  });

  it('tolerates the whitespace a copy-paste adds', () => {
    expect(parseFirebaseConfig(`  ${VALID}\n`)).toHaveProperty('config');
  });
});

describe('a config that cannot be used', () => {
  it('reports an unset variable distinctly from a broken one', () => {
    expect(problemOf(undefined)).toMatch(/not set/);
    expect(problemOf('')).toMatch(/not set/);
    expect(problemOf('   ')).toMatch(/not set/);
  });

  it('reports invalid JSON — the likeliest paste error', () => {
    expect(problemOf('{apiKey: "unquoted"}')).toMatch(/not valid JSON/);
    expect(problemOf('undefined')).toMatch(/not valid JSON/);
  });

  it('rejects JSON that is not an object', () => {
    expect(problemOf('"a string"')).toMatch(/must be a JSON object/);
    expect(problemOf('[]')).toMatch(/must be a JSON object/);
    expect(problemOf('null')).toMatch(/must be a JSON object/);
    expect(problemOf('42')).toMatch(/must be a JSON object/);
  });

  // Naming the field is the whole point: a half-pasted object is a common
  // mistake and "Firebase is not configured" would not help anyone find it.
  it('names every field that is missing', () => {
    expect(problemOf(JSON.stringify({ apiKey: 'k', authDomain: 'd' }))).toBe(
      'NEXT_PUBLIC_FIREBASE_CONFIG is missing projectId, appId',
    );
  });

  it('treats an empty string as missing, not as present', () => {
    const blanked = JSON.stringify({ ...(JSON.parse(VALID) as object), appId: '' });
    expect(problemOf(blanked)).toMatch(/missing appId/);
  });

  it('treats a non-string field as missing', () => {
    const numeric = JSON.stringify({ ...(JSON.parse(VALID) as object), projectId: 123 });
    expect(problemOf(numeric)).toMatch(/missing projectId/);
  });

  // Not secret, but a parse error that prints the blob into a browser console
  // trains people to paste configuration into issue reports.
  it('never echoes the offending value back', () => {
    const problem = problemOf('{"apiKey":"AIzaSyLeakMe","authDomain":"x"');
    expect(problem).not.toContain('AIzaSyLeakMe');
  });
});

/**
 * `authDomain`, which is the one field whose shape matters to something other
 * than this file.
 *
 * Every check above asks whether a field is a non-empty string, and for three
 * fields that is the whole of what can be said. `authDomain` is different: the
 * Firebase SDK interpolates it raw into `https://${authDomain}/__/auth/iframe`,
 * and `lib/csp.ts` turns it into a `frame-src` and `connect-src` entry. A value
 * that is a string but not a hostname passes every earlier check, produces a
 * CSP with sign-in's frame missing, and leaves the operator with a dead login
 * and no message anywhere naming the field — which is precisely what the CSP's
 * own comment used to promise this check was preventing.
 */
describe('an authDomain that is a string but not a hostname', () => {
  function withAuthDomain(authDomain: string): string {
    return JSON.stringify({ ...(JSON.parse(VALID) as object), authDomain });
  }

  it('rejects a wildcard, which is a CSP source expression rather than a host', () => {
    // What an operator types meaning "all our Firebase domains". Legal CSP,
    // meaning "any subdomain" — and a `URL` round trip does not flinch at it.
    expect(problemOf(withAuthDomain('*.firebaseapp.com'))).toMatch(/not a hostname/);
    expect(problemOf(withAuthDomain('*'))).toMatch(/not a hostname/);
  });

  it('rejects the whitespace an environment file carries invisibly', () => {
    // The SDK would request `https://xecret-demo.firebaseapp.com /__/auth/iframe`.
    // Quoted in the message because the difference is otherwise unreadable.
    expect(problemOf(withAuthDomain('xecret-demo.firebaseapp.com '))).toContain(
      '"xecret-demo.firebaseapp.com "',
    );
    expect(problemOf(withAuthDomain(' xecret-demo.firebaseapp.com'))).toMatch(/not a hostname/);
  });

  it('rejects a URL where a domain belongs', () => {
    // Copied from a browser address bar rather than from the SDK snippet. The
    // SDK builds `https://https://…` out of it and fails somewhere unhelpful.
    expect(problemOf(withAuthDomain('https://xecret-demo.firebaseapp.com/'))).toMatch(
      /not a hostname/,
    );
    expect(problemOf(withAuthDomain('xecret-demo.firebaseapp.com/'))).toMatch(/not a hostname/);
    expect(problemOf(withAuthDomain('xecret-demo.firebaseapp.com:443'))).toMatch(/not a hostname/);
  });

  // The message has to be actionable on its own: the reader is a self-hoster
  // whose sign-in page is blank, and "not a hostname" without an example of one
  // is not an improvement on silence.
  it('names the field, shows the value and says what a good one looks like', () => {
    const problem = problemOf(withAuthDomain('*.firebaseapp.com'));

    expect(problem).toContain('NEXT_PUBLIC_FIREBASE_CONFIG');
    expect(problem).toContain('authDomain');
    expect(problem).toContain('"*.firebaseapp.com"');
    expect(problem).toContain('your-project.firebaseapp.com');
  });

  it('still accepts the shapes a Firebase console actually hands out', () => {
    for (const good of [
      'xecret-demo.firebaseapp.com',
      'xecret-demo.web.app',
      'auth.example.co.uk',
      'localhost',
    ]) {
      expect(parseFirebaseConfig(withAuthDomain(good)), good).toHaveProperty('config');
    }
  });
});
