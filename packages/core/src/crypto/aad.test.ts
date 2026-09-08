import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import {
  edkGrantAad,
  ehkGrantAad,
  envKeyAad,
  isAadV2,
  orgKeyAad,
  privateKeyEncAad,
  privateKeySignAad,
  secretAad,
  secretNoteAad,
  secretValueAad,
  userKeyWrapAad,
} from './aad';
import type { RecipientKind } from './aad';
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

/* ────────────────────────────── v2 ────────────────────────────── */

const userId = uuidv7();
const recipientId = uuidv7();
const lookupHashHex = 'a'.repeat(64);

const allV2 = () => [
  secretValueAad(context),
  secretNoteAad({ orgId, environmentId, secretId }),
  edkGrantAad({ environmentId, edkVersion: 1, recipientKind: 'member', recipientId }),
  ehkGrantAad({ environmentId, recipientKind: 'member', recipientId }),
  userKeyWrapAad({ userId, wrapKind: 'passphrase' }),
  userKeyWrapAad({ userId, wrapKind: 'recovery', lookupHashHex }),
  userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'Y3JlZC1pZA' }),
  privateKeyEncAad(userId),
  privateKeySignAad(userId),
];

describe('AAD v2 construction', () => {
  it('carries the v2 prefix and its own purpose', () => {
    expect(secretValueAad(context)).toMatch(/^xecret\.aad\.v2\.secret-value\|/);
    expect(secretNoteAad(context)).toMatch(/^xecret\.aad\.v2\.secret-note\|/);
    expect(
      edkGrantAad({ environmentId, edkVersion: 3, recipientKind: 'token', recipientId }),
    ).toMatch(/^xecret\.aad\.v2\.edk-grant\|/);
    expect(ehkGrantAad({ environmentId, recipientKind: 'invite', recipientId })).toMatch(
      /^xecret\.aad\.v2\.ehk-grant\|/,
    );
    expect(userKeyWrapAad({ userId, wrapKind: 'passphrase' })).toMatch(
      /^xecret\.aad\.v2\.uk-wrap\|/,
    );
    expect(privateKeyEncAad(userId)).toMatch(/^xecret\.aad\.v2\.privkey-enc\|/);
    expect(privateKeySignAad(userId)).toMatch(/^xecret\.aad\.v2\.privkey-sign\|/);
  });

  it('never collides across purposes for the same identifiers', () => {
    expect(new Set(allV2()).size).toBe(allV2().length);
  });

  it('never collides with a v1 AAD', () => {
    const v1 = [
      utf8Decode(orgKeyAad(orgId, 1)),
      utf8Decode(envKeyAad(orgId, environmentId, 1)),
      utf8Decode(secretAad(context)),
    ];
    for (const value of allV2()) expect(v1).not.toContain(value);
  });

  // The v2 purposes are the format the whole client hierarchy is bound to. A
  // change here orphans every blob written under the old string.
  it('renders exactly the strings the spec pins', () => {
    expect(secretValueAad(context)).toBe(
      `xecret.aad.v2.secret-value|${orgId}|${environmentId}|${secretId}|1`,
    );
    expect(secretNoteAad(context)).toBe(
      `xecret.aad.v2.secret-note|${orgId}|${environmentId}|${secretId}`,
    );
    expect(edkGrantAad({ environmentId, edkVersion: 7, recipientKind: 'token', recipientId })).toBe(
      `xecret.aad.v2.edk-grant|${environmentId}|7|token|${recipientId}`,
    );
    expect(ehkGrantAad({ environmentId, recipientKind: 'invite', recipientId })).toBe(
      `xecret.aad.v2.ehk-grant|${environmentId}|invite|${recipientId}`,
    );
    expect(userKeyWrapAad({ userId, wrapKind: 'recovery', lookupHashHex })).toBe(
      `xecret.aad.v2.uk-wrap|${userId}|recovery|${lookupHashHex}`,
    );
    expect(userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'Y3JlZC1pZA' })).toBe(
      `xecret.aad.v2.uk-wrap|${userId}|prf|Y3JlZC1pZA`,
    );
  });

  it('differs when any single component differs', () => {
    const baseline = edkGrantAad({
      environmentId,
      edkVersion: 1,
      recipientKind: 'member',
      recipientId,
    });

    expect(
      edkGrantAad({ environmentId: uuidv7(), edkVersion: 1, recipientKind: 'member', recipientId }),
    ).not.toBe(baseline);
    expect(
      edkGrantAad({ environmentId, edkVersion: 2, recipientKind: 'member', recipientId }),
    ).not.toBe(baseline);
    expect(
      edkGrantAad({ environmentId, edkVersion: 1, recipientKind: 'token', recipientId }),
    ).not.toBe(baseline);
    expect(
      edkGrantAad({ environmentId, edkVersion: 1, recipientKind: 'member', recipientId: uuidv7() }),
    ).not.toBe(baseline);
  });

  // Every recovery wrap holds the same User Key, so without this component a
  // swapped row would go undetected.
  it('binds a recovery wrap to its own code and a prf wrap to its own credential', () => {
    expect(userKeyWrapAad({ userId, wrapKind: 'recovery', lookupHashHex })).not.toBe(
      userKeyWrapAad({ userId, wrapKind: 'recovery', lookupHashHex: 'b'.repeat(64) }),
    );
    expect(userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'aaa' })).not.toBe(
      userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'bbb' }),
    );
  });
});

describe('AAD v2 input validation', () => {
  it('rejects a non-UUID identifier', () => {
    expect(() => secretValueAad({ ...context, orgId: 'nope' })).toThrow(TypeError);
    expect(() => secretNoteAad({ ...context, environmentId: 'nope' })).toThrow(TypeError);
    expect(() =>
      edkGrantAad({ environmentId: 'nope', edkVersion: 1, recipientKind: 'member', recipientId }),
    ).toThrow(TypeError);
    expect(() =>
      ehkGrantAad({ environmentId, recipientKind: 'member', recipientId: 'nope' }),
    ).toThrow(TypeError);
    expect(() => userKeyWrapAad({ userId: 'nope', wrapKind: 'passphrase' })).toThrow(TypeError);
    expect(() => privateKeyEncAad('nope')).toThrow(TypeError);
    expect(() => privateKeySignAad('nope')).toThrow(TypeError);
  });

  it('rejects an unknown recipient or wrap kind', () => {
    expect(() =>
      edkGrantAad({
        environmentId,
        edkVersion: 1,
        recipientKind: 'server' as unknown as RecipientKind,
        recipientId,
      }),
    ).toThrow(TypeError);
    expect(() =>
      ehkGrantAad({ environmentId, recipientKind: '' as unknown as RecipientKind, recipientId }),
    ).toThrow(TypeError);
    expect(() => userKeyWrapAad({ userId, wrapKind: 'pin' as unknown as 'passphrase' })).toThrow(
      TypeError,
    );
  });

  // The delimiter invariant is what makes the encoding unambiguous without
  // length prefixes.
  it('rejects a component containing the delimiter or other punctuation', () => {
    expect(() =>
      userKeyWrapAad({ userId, wrapKind: 'recovery', lookupHashHex: `${lookupHashHex}|extra` }),
    ).toThrow(TypeError);
    expect(() =>
      userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'has spaces' }),
    ).toThrow(TypeError);
    expect(() => userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: '' })).toThrow(
      TypeError,
    );
  });

  it('never echoes the rejected value into the error message', () => {
    try {
      userKeyWrapAad({ userId, wrapKind: 'prf', credentialIdB64Url: 'super|secret|credential' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('super');
    }
  });

  it('rejects a negative or fractional version', () => {
    expect(() => secretValueAad({ ...context, version: -1 })).toThrow(TypeError);
    expect(() =>
      edkGrantAad({ environmentId, edkVersion: 1.5, recipientKind: 'member', recipientId }),
    ).toThrow(TypeError);
  });
});

describe('isAadV2', () => {
  it('accepts every AAD this module produces', () => {
    for (const value of allV2()) expect(isAadV2(value)).toBe(true);
  });

  it('rejects v1 AADs, bare purposes, and anything with a stray delimiter', () => {
    expect(isAadV2(utf8Decode(secretAad(context)))).toBe(false);
    expect(isAadV2('xecret.aad.v2.secret-value')).toBe(false);
    expect(isAadV2(`xecret.aad.v2.secret-value|${orgId}|`)).toBe(false);
    expect(isAadV2('xecret.v2.uk-wrap')).toBe(false);
  });
});
