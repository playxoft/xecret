import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../crypto/encoding';
import {
  deriveOAuthStateKey,
  generateOAuthSecrets,
  MAX_NEXT_LENGTH,
  sealOAuthState,
} from './oauth-state';
import {
  clearedSignInConfirmationCookie,
  deriveSignInConfirmationKey,
  generateConfirmationNonce,
  MAX_SEALED_CONFIRMATION_LENGTH,
  openSignInConfirmation,
  SIGN_IN_CONFIRMATION_COOKIE_NAME,
  SIGN_IN_CONFIRMATION_TTL_SECONDS,
  sealSignInConfirmation,
  signInConfirmationCookie,
} from './sign-in-confirmation';
import type { SignInConfirmation } from './sign-in-confirmation';

/**
 * The sealed cookie that holds a sign-in back until the person confirms it —
 * the defence against the planted-AuthKit-session login CSRF (review S1).
 *
 * Pinned here: a cookie this module did not write, wrote under another
 * cookie's key, or wrote more than five minutes ago is refused, before
 * anything in it is read. That it can be *used* once only is the server's
 * ledger, tested where the confirmation is spent.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const NOW = new Date('2026-10-18T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function parked(over: Partial<SignInConfirmation> = {}): SignInConfirmation {
  return {
    nonce: generateConfirmationNonce(),
    userId: '0198c0de-0000-7000-8000-00000000000a',
    email: 'pat@attacker.example',
    signInMethod: 'sso',
    ssoWorkosOrgId: 'org_01HATTACKER',
    organization: { name: 'Acme Corp', slug: 'acme-corp' },
    purpose: 'sign-in',
    next: '/app',
    flowIssuedAt: NOW_SECONDS - 20,
    freshAuthAt: null,
    lockOne: null,
    outcome: 'matched',
    reason: 'organization',
    providerSessionId: 'session_01HATTACKERSESSION',
    joins: false,
    issuedAt: NOW_SECONDS,
    ...over,
  };
}

async function key() {
  return deriveSignInConfirmationKey(SECRET);
}

async function resealed(payload: Record<string, unknown>): Promise<string> {
  const body = toBase64Url(utf8Encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await key(), utf8Encode(`c1.${body}`));
  return `c1.${body}.${toBase64Url(new Uint8Array(mac))}`;
}

describe('a round trip', () => {
  it('opens what it sealed, field for field', async () => {
    const value = parked({
      purpose: 'reauth',
      lockOne: 'armed',
      freshAuthAt: NOW_SECONDS - 15,
      next: '/cli/authorize?port=50123&state=abc',
    });

    expect(
      await openSignInConfirmation(
        await key(),
        await sealSignInConfirmation(await key(), value),
        NOW,
      ),
    ).toEqual({ ok: true, value });
  });

  it('holds a sign-in that named no organisation, and the longest next, inside one cookie', async () => {
    const value = parked({
      signInMethod: 'password',
      ssoWorkosOrgId: null,
      organization: null,
      reason: 'reused-session',
      email: `${'a'.repeat(300)}@example.com`,
      next: `/${'a'.repeat(MAX_NEXT_LENGTH - 1)}`,
    });
    const cookie = await sealSignInConfirmation(await key(), value);

    expect(signInConfirmationCookie(cookie).length).toBeLessThan(4096);
    expect(await openSignInConfirmation(await key(), cookie, NOW)).toEqual({ ok: true, value });
  });

  it('refuses to seal a value a browser would drop, rather than hand out a cookie nobody can confirm', async () => {
    // Review round 2: the longest `next` beside a long organisation name in
    // four-byte characters ran past 4 KB, and a browser drops such a cookie
    // without a word — the confirmation page then says "expired" for a
    // sign-in that never had a chance.
    const value = parked({
      email: `${'a'.repeat(300)}@example.com`,
      organization: { name: '\u{1F600}'.repeat(100), slug: 'acme-corp' },
      next: `/${'a'.repeat(MAX_NEXT_LENGTH - 1)}`,
    });

    await expect(sealSignInConfirmation(await key(), value)).rejects.toBeInstanceOf(RangeError);
    // The same value with the default destination fits.
    const cookie = await sealSignInConfirmation(await key(), { ...value, next: '/app' });
    expect(cookie.length).toBeLessThanOrEqual(MAX_SEALED_CONFIRMATION_LENGTH);
    expect(`${SIGN_IN_CONFIRMATION_COOKIE_NAME}=${cookie}`.length).toBeLessThanOrEqual(4096);
  });

  it('carries why it was held back, whether continuing joins, and the AuthKit session (review round 2)', async () => {
    const value = parked({
      reason: 'not-member',
      joins: true,
      providerSessionId: 'session_01H93ZY4F80QPBEZ1R5B2SHQG8',
    });
    const opened = await openSignInConfirmation(
      await key(),
      await sealSignInConfirmation(await key(), value),
      NOW,
    );
    expect(opened).toEqual({ ok: true, value });
  });

  it('opens a cookie sealed before those fields existed, reading them as absent', async () => {
    const value = parked();
    const fields = JSON.parse(
      utf8Decode(fromBase64Url((await sealSignInConfirmation(await key(), value)).split('.')[1]!)),
    ) as Record<string, unknown>;
    const { a: _a, w: _w, j: _j, ...roundOne } = fields;

    expect(await openSignInConfirmation(await key(), await resealed(roundOne), NOW)).toEqual({
      ok: true,
      value: { ...value, freshAuthAt: null, providerSessionId: null, joins: false },
    });
  });

  it('mints a fresh 256-bit nonce each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, generateConfirmationNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('a cookie this module did not write', () => {
  it('is refused when its address was changed — the confirmation would name somebody else', async () => {
    const cookie = await sealSignInConfirmation(await key(), parked());
    const [version, payload, mac] = cookie.split('.');
    const fields = JSON.parse(utf8Decode(fromBase64Url(payload!))) as Record<string, unknown>;
    const edited = toBase64Url(
      utf8Encode(JSON.stringify({ ...fields, u: '0198c0de-0000-7000-8000-00000000000b' })),
    );

    expect(await openSignInConfirmation(await key(), `${version}.${edited}.${mac}`, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('is refused under the state cookie’s key — neither cookie can stand in for the other', async () => {
    const value = parked();
    const body = toBase64Url(utf8Encode(JSON.stringify({ n: value.nonce })));
    const stateKey = await deriveOAuthStateKey(SECRET);
    const mac = await crypto.subtle.sign('HMAC', stateKey, utf8Encode(`c1.${body}`));
    const forged = `c1.${body}.${toBase64Url(new Uint8Array(mac))}`;

    expect(await openSignInConfirmation(await key(), forged, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
    // And a real state cookie is not a confirmation at all.
    const { state, verifier } = generateOAuthSecrets();
    const stateCookie = await sealOAuthState(stateKey, {
      state,
      verifier,
      next: '/app',
      purpose: 'sign-in',
      issuedAt: NOW_SECONDS,
      organizationId: null,
    });
    expect((await openSignInConfirmation(await key(), stateCookie, NOW)).ok).toBe(false);
  });

  it.each([
    ['absent', null, 'missing'],
    ['empty', '', 'missing'],
    ['the wrong shape', 'c1.only-two', 'malformed'],
    ['over-long', `c1.${'a'.repeat(5000)}.b`, 'malformed'],
  ])('is refused when %s', async (_label, cookie, reason) => {
    expect(await openSignInConfirmation(await key(), cookie, NOW)).toEqual({ ok: false, reason });
  });
});

describe('its age', () => {
  it('is refused after five minutes, and accepted right up to them', async () => {
    const cookie = await sealSignInConfirmation(await key(), parked());

    const atLimit = new Date((NOW_SECONDS + SIGN_IN_CONFIRMATION_TTL_SECONDS) * 1000);
    const past = new Date((NOW_SECONDS + SIGN_IN_CONFIRMATION_TTL_SECONDS + 1) * 1000);
    expect(SIGN_IN_CONFIRMATION_TTL_SECONDS).toBeLessThanOrEqual(5 * 60);
    expect((await openSignInConfirmation(await key(), cookie, atLimit)).ok).toBe(true);
    expect(await openSignInConfirmation(await key(), cookie, past)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('is refused when issued in the future', async () => {
    const cookie = await sealSignInConfirmation(
      await key(),
      parked({ issuedAt: NOW_SECONDS + 60 }),
    );
    expect(await openSignInConfirmation(await key(), cookie, NOW)).toEqual({
      ok: false,
      reason: 'future',
    });
  });
});

describe('a validly signed payload the confirmation could not act on', () => {
  const base = {
    n: generateConfirmationNonce(),
    u: '0198c0de-0000-7000-8000-00000000000a',
    e: 'pat@example.com',
    m: 'sso',
    s: 'org_01HSSO',
    o: ['Acme', 'acme'],
    p: 'sign-in',
    x: '/app',
    f: NOW_SECONDS,
    l: null,
    k: 'matched',
    r: 'organization',
    t: NOW_SECONDS,
  };

  it('accepts the base payload, so each refusal below is the one field', async () => {
    expect((await openSignInConfirmation(await key(), await resealed(base), NOW)).ok).toBe(true);
  });

  it.each([
    ['a short nonce', { n: 'abc' }],
    ['an account id that is not a UUID', { u: 'admin' }],
    ['an address with a control character', { e: 'pat\n@example.com' }],
    ['a method outside the closed set', { m: 'magic' }],
    ['an SSO organisation beside a password sign-in', { m: 'password' }],
    ['an organisation id of the wrong shape', { s: 'acme' }],
    ['an organisation slug that is not a slug', { o: ['Acme', 'Acme Corp'] }],
    ['an organisation name with a control character', { o: ['Ac\u0000me', 'acme'] }],
    ['an absolute next', { x: 'https://evil.example/' }],
    ['a protocol-relative next', { x: '//evil.example' }],
    ['an unknown purpose', { p: 'admin' }],
    ['a lock-one verdict on an ordinary sign-in', { l: 'armed' }],
    ['a re-authentication with no lock-one verdict', { p: 'reauth' }],
    ['an unknown outcome', { k: 'adopted' }],
    ['an unknown reason', { r: 'because' }],
    ['a non-integer time', { t: 1.5 }],
    ['a non-integer authentication time', { a: '1700000000' }],
    ['a fresh authentication on an ordinary sign-in', { a: NOW_SECONDS }],
    ['an AuthKit session id of the wrong shape', { w: 'session_01../../logout' }],
    ['an AuthKit session id that is not a string', { w: 12 }],
    ['a join flag that is not a boolean', { j: 'yes' }],
  ])('refuses %s', async (_label, over) => {
    expect(
      await openSignInConfirmation(await key(), await resealed({ ...base, ...over }), NOW),
    ).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('the cookie', () => {
  it('is __Host-, HttpOnly, Secure, Lax and lives five minutes', () => {
    const header = signInConfirmationCookie('c1.payload.mac');
    expect(header.startsWith(`${SIGN_IN_CONFIRMATION_COOKIE_NAME}=c1.payload.mac;`)).toBe(true);
    expect(SIGN_IN_CONFIRMATION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    for (const attribute of ['Path=/', 'Max-Age=300', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(header.split('; ')).toContain(attribute);
    }
  });

  it('is cleared with the same attributes', () => {
    const header = clearedSignInConfirmationCookie();
    expect(header.split('; ')).toEqual([
      `${SIGN_IN_CONFIRMATION_COOKIE_NAME}=`,
      'Path=/',
      'Max-Age=0',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ]);
  });
});
