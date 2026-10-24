import { describe, expect, it } from 'vitest';
import { deriveOAuthStateKey } from './oauth-state';
import { deriveSignInConfirmationKey } from './sign-in-confirmation';
import {
  clearedSsoContinueCookie,
  deriveSsoContinueKey,
  generateSsoContinueBinding,
  isWellFormedSsoContinueBinding,
  mintSsoContinueToken,
  SSO_CONTINUE_COOKIE_NAME,
  SSO_CONTINUE_TOKEN_TTL_SECONDS,
  ssoContinueCookie,
  verifySsoContinueToken,
} from './sso-continue';

/**
 * The "Continue with single sign-on" token (review round 2): what the login
 * route requires before it honours `?org=`, so that a request for an
 * organisation's single sign-on is one a person chose on the warning page, in
 * this browser — not one an attacker arranged to arrive same-origin.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const NOW = new Date('2026-10-18T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

async function key() {
  return deriveSsoContinueKey(SECRET);
}

describe('a token', () => {
  it('verifies for the slug and the browser it was minted for, within five minutes', async () => {
    const binding = generateSsoContinueBinding();
    const token = await mintSsoContinueToken(await key(), {
      slug: 'acme',
      binding,
      issuedAt: NOW_SECONDS,
    });

    expect(token).toMatch(/^k1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(
      await verifySsoContinueToken(await key(), token, { slug: 'acme', binding, now: NOW }),
    ).toEqual({
      ok: true,
    });
    const atLimit = new Date((NOW_SECONDS + SSO_CONTINUE_TOKEN_TTL_SECONDS) * 1000);
    expect(
      (await verifySsoContinueToken(await key(), token, { slug: 'acme', binding, now: atLimit }))
        .ok,
    ).toBe(true);
  });

  it('is refused in another browser — one an attacker minted by loading the page themselves', async () => {
    // Without the binding, the page would mint a working token for anybody who
    // loads it, the attacker included, a second before they send the link.
    const attackers = generateSsoContinueBinding();
    const token = await mintSsoContinueToken(await key(), {
      slug: 'attacker-co',
      binding: attackers,
      issuedAt: NOW_SECONDS,
    });

    expect(
      await verifySsoContinueToken(await key(), token, {
        slug: 'attacker-co',
        binding: generateSsoContinueBinding(),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'signature' });
    expect(
      await verifySsoContinueToken(await key(), token, {
        slug: 'attacker-co',
        binding: null,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('is refused for another slug', async () => {
    const binding = generateSsoContinueBinding();
    const token = await mintSsoContinueToken(await key(), {
      slug: 'acme',
      binding,
      issuedAt: NOW_SECONDS,
    });

    expect(
      await verifySsoContinueToken(await key(), token, { slug: 'attacker-co', binding, now: NOW }),
    ).toEqual({ ok: false, reason: 'signature' });
  });

  it('is refused under another cookie’s key', async () => {
    const binding = generateSsoContinueBinding();
    for (const other of [
      await deriveOAuthStateKey(SECRET),
      await deriveSignInConfirmationKey(SECRET),
    ]) {
      const token = await mintSsoContinueToken(other, {
        slug: 'acme',
        binding,
        issuedAt: NOW_SECONDS,
      });
      expect(
        await verifySsoContinueToken(await key(), token, { slug: 'acme', binding, now: NOW }),
      ).toEqual({ ok: false, reason: 'signature' });
    }
  });

  it('is refused after five minutes, and from the future', async () => {
    const binding = generateSsoContinueBinding();
    const old = await mintSsoContinueToken(await key(), {
      slug: 'acme',
      binding,
      issuedAt: NOW_SECONDS - SSO_CONTINUE_TOKEN_TTL_SECONDS - 1,
    });
    const future = await mintSsoContinueToken(await key(), {
      slug: 'acme',
      binding,
      issuedAt: NOW_SECONDS + 60,
    });

    expect(
      await verifySsoContinueToken(await key(), old, { slug: 'acme', binding, now: NOW }),
    ).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      await verifySsoContinueToken(await key(), future, { slug: 'acme', binding, now: NOW }),
    ).toEqual({ ok: false, reason: 'future' });
  });

  it.each([
    ['absent', null, 'missing'],
    ['empty', '', 'missing'],
    ['the wrong version', 'k0.1.AAAA', 'malformed'],
    ['the wrong shape', 'k1.notanumber.abc', 'malformed'],
    ['over-long', `k1.1.${'a'.repeat(500)}`, 'malformed'],
  ])('is refused when %s', async (_label, token, reason) => {
    expect(
      await verifySsoContinueToken(await key(), token, {
        slug: 'acme',
        binding: generateSsoContinueBinding(),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason });
  });

  it('is refused against a binding cookie of the wrong shape', async () => {
    const binding = generateSsoContinueBinding();
    const token = await mintSsoContinueToken(await key(), {
      slug: 'acme',
      binding,
      issuedAt: NOW_SECONDS,
    });
    expect(
      await verifySsoContinueToken(await key(), token, {
        slug: 'acme',
        binding: 'short',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is never minted for a value that is not a slug or a binding', async () => {
    const binding = generateSsoContinueBinding();
    await expect(
      mintSsoContinueToken(await key(), { slug: 'Not A Slug', binding, issuedAt: NOW_SECONDS }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      mintSsoContinueToken(await key(), { slug: 'acme', binding: 'x', issuedAt: NOW_SECONDS }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('the binding cookie', () => {
  it('is 256 random bits, __Host-, HttpOnly, Secure and Lax', () => {
    const bindings = new Set(Array.from({ length: 20 }, generateSsoContinueBinding));
    expect(bindings.size).toBe(20);
    for (const binding of bindings) expect(isWellFormedSsoContinueBinding(binding)).toBe(true);

    const header = ssoContinueCookie('b'.repeat(43));
    expect(SSO_CONTINUE_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(header.startsWith(`${SSO_CONTINUE_COOKIE_NAME}=${'b'.repeat(43)};`)).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(header.split('; ')).toContain(attribute);
    }
    expect(clearedSsoContinueCookie().split('; ')).toContain('Max-Age=0');
  });
});
