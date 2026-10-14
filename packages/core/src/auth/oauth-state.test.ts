import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../crypto/encoding';
import {
  clearedOAuthStateCookie,
  deriveOAuthStateKey,
  generateOAuthSecrets,
  MAX_NEXT_LENGTH,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  oauthStateCookie,
  openOAuthState,
  sealOAuthState,
} from './oauth-state';
import type { OAuthState } from './oauth-state';

/**
 * The sign-in state cookie: the login-CSRF defence for a callback that the
 * double-submit token cannot protect, and the carrier of everything the
 * callback must not take from the query string.
 *
 * What these tests pin is that a cookie this module did not write — or wrote
 * for a different flow, or wrote too long ago — is refused, and that the
 * refusal happens before anything inside the cookie is interpreted.
 */

const SECRET = 'a-perfectly-random-thirty-two-plus-character-secret';
const NOW = new Date('2026-10-12T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function flow(over: Partial<OAuthState> = {}): OAuthState {
  const { state, verifier } = generateOAuthSecrets();
  return { state, verifier, next: '/app', purpose: 'sign-in', issuedAt: NOW_SECONDS, ...over };
}

async function sealed(value: OAuthState, secret = SECRET): Promise<string> {
  return sealOAuthState(await deriveOAuthStateKey(secret), value);
}

async function open(cookie: string | null, state: string | null, now = NOW, secret = SECRET) {
  return openOAuthState(await deriveOAuthStateKey(secret), cookie, state, now);
}

/** Re-signs a hand-edited payload with the real key: what a key holder could mint. */
async function resealed(payload: Record<string, unknown>): Promise<string> {
  const key = await deriveOAuthStateKey(SECRET);
  const body = toBase64Url(utf8Encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', key, utf8Encode(`v1.${body}`));
  return `v1.${body}.${toBase64Url(new Uint8Array(mac))}`;
}

describe('a round trip', () => {
  it('opens what it sealed, field for field', async () => {
    const value = flow({ next: '/cli/authorize?port=50123&state=abc', purpose: 'reauth' });

    const result = await open(await sealed(value), value.state);

    expect(result).toEqual({ ok: true, value });
  });

  it('mints a fresh 256-bit state and a valid PKCE verifier each time', () => {
    const a = generateOAuthSecrets();
    const b = generateOAuthSecrets();

    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(a.verifier);
  });
});

describe('a cookie this module did not write', () => {
  it('is refused when a byte of the payload changed', async () => {
    const value = flow();
    const cookie = await sealed(value);
    const [version, payload = '', mac] = cookie.split('.');
    const decoded = JSON.parse(utf8Decode(fromBase64Url(payload))) as Record<string, unknown>;
    // The attack worth worrying about: same flow, a different destination.
    decoded['n'] = '/app/settings/danger';
    const forged = `${version}.${toBase64Url(utf8Encode(JSON.stringify(decoded)))}.${mac}`;

    expect(await open(forged, value.state)).toEqual({ ok: false, reason: 'signature' });
  });

  it('is refused when its purpose is promoted to a re-authentication', async () => {
    const value = flow({ purpose: 'sign-in' });
    const [version, payload = '', mac] = (await sealed(value)).split('.');
    const decoded = JSON.parse(utf8Decode(fromBase64Url(payload))) as Record<string, unknown>;
    decoded['p'] = 'reauth';
    const forged = `${version}.${toBase64Url(utf8Encode(JSON.stringify(decoded)))}.${mac}`;

    expect(await open(forged, value.state)).toEqual({ ok: false, reason: 'signature' });
  });

  it('is refused when the MAC changed', async () => {
    const value = flow();
    const cookie = await sealed(value);
    // The MAC's *first* character, not its last: 32 bytes are 43 base64url
    // characters, and the last one's two low bits are padding that decoding
    // drops — so swapping a final 'A' for 'B' changes nothing, and the cookie
    // rightly verified one run in sixteen. Every bit of the first one counts.
    const dot = cookie.lastIndexOf('.');
    const first = cookie[dot + 1] === 'A' ? 'B' : 'A';
    const changed = `${cookie.slice(0, dot + 1)}${first}${cookie.slice(dot + 2)}`;

    expect(changed).not.toBe(cookie);
    expect(await open(changed, value.state)).toEqual({ ok: false, reason: 'signature' });
  });

  it('is refused under a different secret — a MAC verifies under one key only', async () => {
    const value = flow();
    const cookie = await sealed(value, 'another-secret-that-is-also-long-enough-xx');

    expect(await open(cookie, value.state)).toEqual({ ok: false, reason: 'signature' });
  });

  it.each([
    ['empty', ''],
    ['one part', 'v1'],
    ['an unknown version', 'v2.e30.AAAA'],
    ['four parts', 'v1.a.b.c'],
    ['a MAC that is not base64url', 'v1.e30.***'],
    ['a short MAC', 'v1.e30.AAAA'],
    ['an oversized cookie', `v1.${'a'.repeat(5000)}.AAAA`],
  ])('is refused when it is %s', async (_label, cookie) => {
    const result = await open(cookie, 'whatever');
    expect(result.ok).toBe(false);
  });

  it('is refused when absent — a callback this browser never started', async () => {
    expect(await open(null, 'whatever')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('a cookie that is real but not for this callback', () => {
  it('is refused when the provider sent back a different state', async () => {
    const value = flow();
    const other = generateOAuthSecrets().state;

    expect(await open(await sealed(value), other)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it.each([
    ['no state at all', null],
    ['an empty state', ''],
    ['a prefix of the real one', 'x'],
  ])('is refused with %s', async (_label, state) => {
    const value = flow();
    const presented = state === 'x' ? value.state.slice(0, 10) : state;

    expect(await open(await sealed(value), presented)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('is refused after its lifetime, and accepted right up to it', async () => {
    const value = flow({ issuedAt: NOW_SECONDS - OAUTH_STATE_TTL_SECONDS });
    expect(await open(await sealed(value), value.state)).toMatchObject({ ok: true });

    const stale = flow({ issuedAt: NOW_SECONDS - OAUTH_STATE_TTL_SECONDS - 1 });
    expect(await open(await sealed(stale), stale.state)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is refused when issued in the future beyond the tolerated skew', async () => {
    const value = flow({ issuedAt: NOW_SECONDS + 60 });

    expect(await open(await sealed(value), value.state)).toEqual({ ok: false, reason: 'future' });
  });
});

describe('a validly signed payload the callback could not act on', () => {
  // Only a key holder could mint these. They are refused anyway, because "the
  // MAC was fine" is not the same statement as "this is a usable flow".
  const base = {
    s: generateOAuthSecrets().state,
    v: generateOAuthSecrets().verifier,
    n: '/app',
    p: 'sign-in',
    t: NOW_SECONDS,
  };

  it.each([
    ['an absolute next', { n: 'https://evil.example/' }],
    ['a protocol-relative next', { n: '//evil.example' }],
    ['a backslash in next', { n: '/\\evil.example' }],
    ['a control character in next', { n: '/\t/evil.example' }],
    ['a relative next', { n: 'app' }],
    ['an empty next', { n: '' }],
    ['an over-long next', { n: `/${'a'.repeat(MAX_NEXT_LENGTH)}` }],
    ['an unknown purpose', { p: 'admin' }],
    ['a short verifier', { v: 'abc' }],
    ['a non-integer time', { t: 1.5 }],
    ['a state of the wrong shape', { s: 'not-a-state' }],
  ])('refuses %s', async (_label, over) => {
    const cookie = await resealed({ ...base, ...over });
    expect(await open(cookie, (over as { s?: string }).s ?? base.s)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('the key', () => {
  it('refuses a secret shorter than 32 characters rather than signing with it', async () => {
    await expect(deriveOAuthStateKey('short')).rejects.toBeInstanceOf(RangeError);
    await expect(deriveOAuthStateKey('x'.repeat(31))).rejects.toBeInstanceOf(RangeError);
    await expect(deriveOAuthStateKey('x'.repeat(32))).resolves.toBeDefined();
  });
});

describe('the cookie', () => {
  it('is __Host-, HttpOnly, Secure, Lax and lives as long as the flow', () => {
    const header = oauthStateCookie('v1.a.b');

    expect(header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=v1.a.b;`)).toBe(true);
    expect(OAUTH_STATE_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    // Lax, not Strict: the callback is a cross-site top-level navigation, and
    // Strict would strip the cookie from exactly the request that needs it.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${OAUTH_STATE_TTL_SECONDS}`);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('is cleared with the same attributes', () => {
    const header = clearedOAuthStateCookie();

    expect(header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=;`)).toBe(true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });
});
