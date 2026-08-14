import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../ids/uuid-v7';
import { toBase64Url } from '../crypto/encoding';
import { CSRF_COOKIE_NAME, csrfCookie, generateCsrfToken, isSafeMethod, verifyCsrf } from './csrf';
import {
  clearedSessionCookie,
  evaluateSession,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_INTERVAL_MS,
  serializeCookie,
  sessionCookie,
  sessionExpiryFrom,
  shouldTouchSession,
} from './session';
import type { SessionRecord } from './session';
import { INVITATION_TTL_MS, invitationExpiryFrom, invitationState } from './invitation';
import { generateToken, hashToken, isWellFormedToken, verifyToken } from './tokens';

const NOW = new Date('2026-08-11T12:00:00Z');

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: uuidv7(),
    userId: uuidv7(),
    expiresAt: new Date(NOW.getTime() + SESSION_LIFETIME_MS),
    lastSeenAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

describe('token generation', () => {
  it('produces a prefixed, three-part token', async () => {
    const { token } = await generateToken('cli');
    expect(token).toMatch(/^xct_live_[A-Za-z0-9_-]{43}$/);
  });

  it('uses a distinct prefix per kind, so one cannot pass as another', async () => {
    const prefixes = await Promise.all(
      (['session', 'cli', 'service', 'invitation'] as const).map(
        async (kind) => (await generateToken(kind)).token.split('_')[0],
      ),
    );
    expect(new Set(prefixes).size).toBe(4);
  });

  it('marks test tokens distinctly from live ones', async () => {
    expect((await generateToken('cli', 'test')).token).toContain('_test_');
  });

  it('never repeats', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 500 }, async () => (await generateToken('session')).token),
    );
    expect(new Set(tokens).size).toBe(500);
  });

  it('exposes a display prefix that is not usable as a credential', async () => {
    const { token, prefix } = await generateToken('cli');

    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length / 2);
    expect(await verifyToken(prefix, await hashToken(token))).toBe(false);
  });
});

describe('token hashing', () => {
  it('stores a 256-bit digest, never the token', async () => {
    const { token, hash } = await generateToken('session');

    expect(hash).toHaveLength(32);
    expect(toBase64Url(hash)).not.toContain(token.split('_')[2]);
  });

  it('is deterministic', async () => {
    const { token } = await generateToken('session');
    expect(await hashToken(token)).toEqual(await hashToken(token));
  });

  it('verifies the correct token and rejects everything else', async () => {
    const { token, hash } = await generateToken('cli');
    const other = await generateToken('cli');

    expect(await verifyToken(token, hash)).toBe(true);
    expect(await verifyToken(other.token, hash)).toBe(false);
    expect(await verifyToken(`${token}x`, hash)).toBe(false);
    expect(await verifyToken(token.slice(0, -1), hash)).toBe(false);
  });
});

describe('token shape validation', () => {
  it('accepts a freshly generated token of the right kind', async () => {
    const { token } = await generateToken('cli');
    expect(isWellFormedToken(token, 'cli')).toBe(true);
    expect(isWellFormedToken(token)).toBe(true);
  });

  // Regression: the base64url alphabet contains `_`, which is also the field
  // delimiter. A naive `split('_')` rejected roughly half of all valid tokens.
  // 200 iterations makes the probability of missing it negligible.
  it('accepts every generated token, including those with an underscore in the secret', async () => {
    let sawUnderscore = false;

    for (let i = 0; i < 200; i += 1) {
      const { token } = await generateToken('cli');
      if (token.slice(9).includes('_')) sawUnderscore = true;
      expect(isWellFormedToken(token, 'cli')).toBe(true);
    }

    expect(sawUnderscore, 'expected at least one secret containing an underscore').toBe(true);
  });

  it('rejects a token of the wrong kind', async () => {
    const { token } = await generateToken('service');
    expect(isWellFormedToken(token, 'cli')).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['garbage', 'no separators'],
    ['xct_live', 'too few parts'],
    ['xct_live_abc_def', 'too many parts'],
    ['xxx_live_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'unknown prefix'],
    ['xct_prod_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'unknown environment'],
    ['xct_live_tooshort', 'wrong secret length'],
    ['xct_live_not+base64url/at@all', 'invalid encoding'],
  ])('rejects %s (%s)', (token) => {
    expect(isWellFormedToken(token)).toBe(false);
  });
});

describe('session evaluation', () => {
  it('accepts a fresh session', () => {
    const result = evaluateSession(record(), NOW);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown session', () => {
    expect(evaluateSession(null, NOW)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired session', () => {
    const expired = record({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(evaluateSession(expired, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a session at the exact moment of expiry', () => {
    const boundary = record({ expiresAt: NOW });
    expect(evaluateSession(boundary, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  // Instant revocation is the whole reason xecret issues its own sessions rather
  // than relying on Firebase ID tokens (ADR 0003).
  it('rejects a revoked session even if it has not expired', () => {
    const revoked = record({ revokedAt: new Date(NOW.getTime() - 1000) });
    expect(evaluateSession(revoked, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('reports revocation in preference to expiry, for accurate audit records', () => {
    const both = record({
      revokedAt: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() - 1),
    });
    expect(evaluateSession(both, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects an idle session before its absolute lifetime runs out', () => {
    const idle = record({ lastSeenAt: new Date(NOW.getTime() - SESSION_IDLE_MS - 1) });

    // Still within the 30-day absolute lifetime, but unused for over 7 days.
    expect(idle.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(evaluateSession(idle, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a session used just within the idle window', () => {
    const idle = record({ lastSeenAt: new Date(NOW.getTime() - SESSION_IDLE_MS + 1000) });
    expect(evaluateSession(idle, NOW).ok).toBe(true);
  });
});

describe('session touch throttling', () => {
  it('does not write on every request', () => {
    const session = { id: uuidv7(), userId: uuidv7(), expiresAt: NOW, lastSeenAt: NOW };
    expect(shouldTouchSession(session, NOW)).toBe(false);
  });

  it('writes once the interval has elapsed', () => {
    const session = {
      id: uuidv7(),
      userId: uuidv7(),
      expiresAt: NOW,
      lastSeenAt: new Date(NOW.getTime() - SESSION_TOUCH_INTERVAL_MS),
    };
    expect(shouldTouchSession(session, NOW)).toBe(true);
  });
});

describe('session cookie', () => {
  it('uses the __Host- prefix, which browsers enforce', () => {
    // Requires Secure, Path=/, and no Domain — so a subdomain, including one an
    // attacker controls via a dangling DNS record, cannot overwrite it.
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  it('is HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    const cookie = sessionCookie('token-value');

    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });
  });

  it('serialises without a Domain attribute', () => {
    const header = serializeCookie(sessionCookie('token-value'));

    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Domain');
  });

  it('clears with Max-Age=0 on logout', () => {
    expect(serializeCookie(clearedSessionCookie())).toContain('Max-Age=0');
  });

  it('expires in step with the session lifetime', () => {
    expect(sessionCookie('t').maxAge).toBe(SESSION_LIFETIME_MS / 1000);
    expect(sessionExpiryFrom(NOW).getTime()).toBe(NOW.getTime() + SESSION_LIFETIME_MS);
  });
});

describe('CSRF', () => {
  it('treats only read methods as safe', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(isSafeMethod(method)).toBe(true);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });

  it('accepts a matching pair', () => {
    const token = generateCsrfToken();
    expect(verifyCsrf(token, token)).toEqual({ ok: true });
  });

  it('rejects a mismatch, a missing cookie, and a missing header', () => {
    const token = generateCsrfToken();

    expect(verifyCsrf(token, generateCsrfToken())).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyCsrf(null, token)).toEqual({ ok: false, reason: 'missing-cookie' });
    expect(verifyCsrf(token, null)).toEqual({ ok: false, reason: 'missing-header' });
    expect(verifyCsrf('', '')).toEqual({ ok: false, reason: 'missing-cookie' });
  });

  it('rejects a token that merely shares a prefix', () => {
    const token = generateCsrfToken();
    expect(verifyCsrf(token, token.slice(0, -1))).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('generates unpredictable tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateCsrfToken));
    expect(tokens.size).toBe(500);
  });

  // Deliberately readable by JavaScript: the client must echo it in a header.
  // It carries no authority without the HttpOnly session cookie.
  it('sets a Secure, non-HttpOnly cookie', () => {
    const header = csrfCookie(generateCsrfToken(), 3600);

    expect(header).toContain(CSRF_COOKIE_NAME);
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('HttpOnly');
  });
});

describe('invitation lifecycle', () => {
  const open = {
    expiresAt: new Date(NOW.getTime() + INVITATION_TTL_MS),
    acceptedAt: null,
    revokedAt: null,
  };

  it('stands for seven days', () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(invitationExpiryFrom(NOW).getTime() - NOW.getTime()).toBe(INVITATION_TTL_MS);
  });

  it('reads an open, unexpired invitation as pending', () => {
    expect(invitationState(open, NOW)).toBe('pending');
  });

  it('expires at the boundary instant, not after it', () => {
    expect(invitationState({ ...open, expiresAt: NOW }, NOW)).toBe('expired');
  });

  it('lets the explicit endings win over expiry', () => {
    // A revoked-then-expired invitation reads as revoked: the fact somebody
    // withdrew it is the informative one, and the one the audit trail records.
    const past = new Date(NOW.getTime() - 1000);

    expect(invitationState({ expiresAt: past, acceptedAt: past, revokedAt: null }, NOW)).toBe(
      'accepted',
    );
    expect(invitationState({ expiresAt: past, acceptedAt: null, revokedAt: past }, NOW)).toBe(
      'revoked',
    );
  });

  it('ranks accepted above revoked, so a corrupt row still reads deterministically', () => {
    const past = new Date(NOW.getTime() - 1000);

    expect(invitationState({ expiresAt: past, acceptedAt: past, revokedAt: past }, NOW)).toBe(
      'accepted',
    );
  });
});
