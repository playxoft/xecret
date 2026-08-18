import { describe, expect, it } from 'vitest';
import {
  CLI_AUTH_CODE_TTL_MS,
  cliAuthCodeExpiryFrom,
  computePkceChallenge,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  verifyPkce,
} from './pkce';

/** The worked example from RFC 7636 appendix B. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('computePkceChallenge', () => {
  it('matches the RFC 7636 test vector — the CLI computes the same digest', async () => {
    expect(await computePkceChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it('produces exactly 43 unpadded base64url characters', async () => {
    expect(PKCE_CHALLENGE_PATTERN.test(await computePkceChallenge(RFC_VERIFIER))).toBe(true);
  });
});

describe('verifyPkce', () => {
  it('accepts the matching pair', async () => {
    expect(await verifyPkce(RFC_CHALLENGE, RFC_VERIFIER)).toBe(true);
  });

  it('rejects a verifier for a different challenge', async () => {
    const otherChallenge = await computePkceChallenge('a'.repeat(43));
    expect(await verifyPkce(otherChallenge, RFC_VERIFIER)).toBe(false);
  });

  it('rejects a verifier that is one character off', async () => {
    const nearMiss = `${RFC_VERIFIER.slice(0, -1)}X`;
    expect(await verifyPkce(RFC_CHALLENGE, nearMiss)).toBe(false);
  });

  it('rejects a too-short verifier without computing anything', async () => {
    // 42 characters — below the RFC minimum. Shape is refused before digest.
    expect(await verifyPkce(RFC_CHALLENGE, 'a'.repeat(42))).toBe(false);
  });

  it('rejects a verifier with characters outside the unreserved set', async () => {
    expect(await verifyPkce(RFC_CHALLENGE, `${'a'.repeat(42)}+`)).toBe(false);
  });

  it('rejects a malformed stored challenge rather than throwing', async () => {
    expect(await verifyPkce('not-a-challenge', RFC_VERIFIER)).toBe(false);
    expect(await verifyPkce('', RFC_VERIFIER)).toBe(false);
  });

  it('never accepts the plain method — challenge equal to verifier fails', async () => {
    // A 43-char verifier that is its own "challenge" would pass under the
    // RFC's `plain` method. Only S256 exists here.
    const verifier = 'a'.repeat(43);
    expect(await verifyPkce(verifier, verifier)).toBe(false);
  });
});

describe('verifier pattern', () => {
  it('accepts the RFC bounds and rejects outside them', () => {
    expect(PKCE_VERIFIER_PATTERN.test('a'.repeat(43))).toBe(true);
    expect(PKCE_VERIFIER_PATTERN.test('a'.repeat(128))).toBe(true);
    expect(PKCE_VERIFIER_PATTERN.test('a'.repeat(42))).toBe(false);
    expect(PKCE_VERIFIER_PATTERN.test('a'.repeat(129))).toBe(false);
  });
});

describe('authorization code expiry', () => {
  it('is ten minutes from now', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    expect(cliAuthCodeExpiryFrom(now).getTime() - now.getTime()).toBe(CLI_AUTH_CODE_TTL_MS);
    expect(CLI_AUTH_CODE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
