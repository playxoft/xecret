import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import { envKeyAad, orgKeyAad, secretAad } from './aad';
import { utf8Decode } from './encoding';

const orgId = uuidv7();
const environmentId = uuidv7();
const secretId = uuidv7();

const context = { orgId, environmentId, secretId, version: 1 };

describe('AAD construction', () => {
  it('is domain-separated and versioned', () => {
    expect(utf8Decode(orgKeyAad(orgId, 1))).toMatch(/^xecret\.aad\.v1\.org-key\|/);
    expect(utf8Decode(envKeyAad(orgId, environmentId, 1))).toMatch(/^xecret\.aad\.v1\.env-key\|/);
    expect(utf8Decode(secretAad(context))).toMatch(/^xecret\.aad\.v1\.secret\|/);
  });

  it('is deterministic for the same inputs', () => {
    expect(secretAad(context)).toEqual(secretAad({ ...context }));
  });

  // Each of these is a distinct relocation attack that AAD binding must defeat.
  it('differs when any single component differs', () => {
    const baseline = utf8Decode(secretAad(context));

    expect(utf8Decode(secretAad({ ...context, orgId: uuidv7() }))).not.toBe(baseline);
    expect(utf8Decode(secretAad({ ...context, environmentId: uuidv7() }))).not.toBe(baseline);
    expect(utf8Decode(secretAad({ ...context, secretId: uuidv7() }))).not.toBe(baseline);
    expect(utf8Decode(secretAad({ ...context, version: 2 }))).not.toBe(baseline);
  });

  it('never collides across purposes for the same identifiers', () => {
    const all = new Set([
      utf8Decode(orgKeyAad(orgId, 1)),
      utf8Decode(envKeyAad(orgId, environmentId, 1)),
      utf8Decode(secretAad(context)),
    ]);
    expect(all.size).toBe(3);
  });
});

describe('AAD input validation', () => {
  // The UUID assertion is load-bearing, not cosmetic: the `|` delimiter is only
  // unambiguous because no component can contain one. A component carrying `|`
  // could otherwise forge the AAD of a different tuple.
  it('rejects a non-UUID identifier', () => {
    expect(() => orgKeyAad('not-a-uuid', 1)).toThrow(TypeError);
    expect(() => envKeyAad(orgId, 'nope', 1)).toThrow(TypeError);
    expect(() => secretAad({ ...context, secretId: 'nope' })).toThrow(TypeError);
  });

  it('rejects an identifier containing the delimiter', () => {
    expect(() => orgKeyAad(`${orgId}|extra`, 1)).toThrow(TypeError);
  });

  it('never echoes the rejected value into the error message', () => {
    // Error messages reach logs; a secret identifier must not ride along.
    try {
      orgKeyAad('super-secret-looking-value', 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-looking-value');
    }
  });

  it('rejects a negative or fractional version', () => {
    expect(() => orgKeyAad(orgId, -1)).toThrow(TypeError);
    expect(() => orgKeyAad(orgId, 1.5)).toThrow(TypeError);
    expect(() => secretAad({ ...context, version: -1 })).toThrow(TypeError);
  });
});
