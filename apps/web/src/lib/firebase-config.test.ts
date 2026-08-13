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
