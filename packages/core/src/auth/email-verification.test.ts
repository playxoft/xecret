import { describe, expect, it } from 'vitest';
import { toBase64Url, utf8Encode } from '../crypto/encoding';
import {
  clearedEmailVerificationCookie,
  deriveEmailVerificationKey,
  EMAIL_VERIFICATION_COOKIE_NAME,
  EMAIL_VERIFICATION_TTL_SECONDS,
  emailVerificationCookie,
  isSameVerificationAddress,
  openEmailVerification,
  sealEmailVerification,
} from './email-verification';
import { deriveSignInConfirmationKey } from './sign-in-confirmation';

/**
 * The sealed cookie that carries a paused password sign-in's pending token to
 * its emailed code. Pinned here: a cookie this module did not write, wrote
 * under another cookie's key, or wrote more than ten minutes ago is refused
 * before anything in it is read; and what it carries comes back exactly.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const NOW = new Date('2026-11-08T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const VALUE = { email: 'Pat@Example.com', pendingToken: 'pending_tok_07', issuedAt: NOW_SECONDS };

describe('the email-verification cookie', () => {
  it('carries the address, the pending token and the moment, and gives them back', async () => {
    const key = await deriveEmailVerificationKey(SECRET);
    const sealed = await sealEmailVerification(key, VALUE);

    expect(sealed.startsWith('v1.')).toBe(true);
    expect(await openEmailVerification(key, sealed, NOW)).toEqual({ ok: true, value: VALUE });
  });

  it('refuses one sealed under another cookie’s key', async () => {
    const sealed = await sealEmailVerification(await deriveSignInConfirmationKey(SECRET), VALUE);

    expect(
      await openEmailVerification(await deriveEmailVerificationKey(SECRET), sealed, NOW),
    ).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses one whose payload was changed after it was sealed', async () => {
    const key = await deriveEmailVerificationKey(SECRET);
    const [version, , mac] = (await sealEmailVerification(key, VALUE)).split('.');
    const forged = toBase64Url(
      utf8Encode(JSON.stringify({ e: 'victim@example.com', p: 'pending_tok_07', t: NOW_SECONDS })),
    );

    expect(await openEmailVerification(key, `${version}.${forged}.${mac}`, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuses one older than its ten minutes, and one dated in the future', async () => {
    const key = await deriveEmailVerificationKey(SECRET);
    const old = await sealEmailVerification(key, {
      ...VALUE,
      issuedAt: NOW_SECONDS - EMAIL_VERIFICATION_TTL_SECONDS - 1,
    });
    const ahead = await sealEmailVerification(key, { ...VALUE, issuedAt: NOW_SECONDS + 600 });

    expect(await openEmailVerification(key, old, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(await openEmailVerification(key, ahead, NOW)).toEqual({ ok: false, reason: 'future' });
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['v1.only-two', 'malformed'],
    ['v2.a.b', 'malformed'],
    ['v1.e30.not!base64', 'malformed'],
    ['v1.e30.AAAA', 'malformed'],
    [`v1.${'A'.repeat(5000)}.AAAA`, 'malformed'],
  ] as const)('refuses %j as %s', async (cookie, reason) => {
    const key = await deriveEmailVerificationKey(SECRET);
    expect(await openEmailVerification(key, cookie, NOW)).toEqual({ ok: false, reason });
  });

  it('refuses to seal what it would refuse to read back', async () => {
    const key = await deriveEmailVerificationKey(SECRET);
    for (const value of [
      { ...VALUE, email: '' },
      { ...VALUE, email: 'no-at-sign' },
      { ...VALUE, email: 'line\nbreak@example.com' },
      { ...VALUE, pendingToken: 'has space' },
      { ...VALUE, pendingToken: '' },
      { ...VALUE, issuedAt: 0 },
    ]) {
      await expect(sealEmailVerification(key, value)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('is HttpOnly, Secure, SameSite=Strict and __Host-, for ten minutes; and clears the same way', () => {
    const set = emailVerificationCookie('v1.a.b');
    expect(set.startsWith(`${EMAIL_VERIFICATION_COOKIE_NAME}=v1.a.b;`)).toBe(true);
    expect(EMAIL_VERIFICATION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(set).toContain(attribute);
      expect(clearedEmailVerificationCookie()).toContain(attribute);
    }
    expect(set).toContain(`Max-Age=${EMAIL_VERIFICATION_TTL_SECONDS}`);
    expect(clearedEmailVerificationCookie()).toContain('Max-Age=0');
  });

  it('compares addresses folding ASCII capitals and surrounding spaces only', () => {
    expect(isSameVerificationAddress('Pat@Example.com', ' pat@example.COM ')).toBe(true);
    expect(isSameVerificationAddress('pat@example.com', 'pat@example.org')).toBe(false);
    expect(isSameVerificationAddress('pat@example.com', 'pаt@example.com')).toBe(false);
  });
});
