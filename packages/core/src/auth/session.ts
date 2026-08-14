import type { Session, SessionResolution } from './types';

/**
 * Session policy: lifetime, sliding renewal, and cookie construction.
 *
 * Kept separate from storage so the rules are unit-testable without a database,
 * and so there is one place to review what "a valid session" means.
 */

/**
 * Absolute lifetime. A session dies 30 days after creation no matter how
 * actively it is used, so a token stolen from a long-lived browser profile has
 * a bounded window.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Idle timeout, now equal to the absolute lifetime — so in practice there is no
 * separate idle rule, and a session lasts the full 30 days.
 *
 * ── Why this was 7 days, and why it is not any more ──
 * The idle rule existed to bound one specific compromise: an abandoned session
 * on a shared or lost machine. It bought that at a real cost — anyone back from
 * two weeks' leave signed in again — and it bought it badly, because seven days
 * is a long time to leave a laptop open on a desk.
 *
 * The unlock PIN (see `pin.ts`) addresses the same threat directly and far
 * better: an idle session re-locks after eight hours, and the cookie on its own
 * cannot read a secret. Keeping both would mean paying the idle rule's cost for
 * protection the PIN already provides more tightly.
 *
 * The constant stays rather than being deleted, and `evaluateSession` still
 * applies it. Removing the mechanism would make re-introducing a shorter window
 * — for a deployment that chooses not to require PINs, say — a code change
 * rather than a number change.
 */
export const SESSION_IDLE_MS = SESSION_LIFETIME_MS;

/**
 * How stale `last_seen_at` may get before it is written again.
 *
 * Without this, every authenticated request would issue a write purely to
 * update a timestamp — turning a read-only page load into a database write and
 * making the hot path needlessly expensive.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The `__Host-` prefix is a browser-enforced guarantee, not a naming
 * convention: the cookie must be Secure, must have Path=/, and must have no
 * Domain attribute. A subdomain — including one an attacker controls via a
 * dangling DNS record — therefore cannot overwrite it.
 */
export const SESSION_COOKIE_NAME = '__Host-xecret_session';

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

/** Decides whether a stored session row is usable right now. */
export function evaluateSession(record: SessionRecord | null, now: Date): SessionResolution {
  if (!record) return { ok: false, reason: 'unknown' };

  // Revocation is checked before expiry so an explicitly revoked session is
  // reported as revoked even after it would also have expired — the distinction
  // matters in audit logs.
  if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

  if (now.getTime() - record.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    return { ok: false, reason: 'expired' };
  }

  const session: Session = {
    id: record.id,
    userId: record.userId,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
  };
  return { ok: true, session };
}

/** True when `last_seen_at` is stale enough to be worth a write. */
export function shouldTouchSession(session: Session, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS);
}

export interface CookieOptions {
  name: string;
  value: string;
  httpOnly: true;
  secure: true;
  sameSite: 'Lax';
  path: '/';
  maxAge: number;
}

/**
 * Cookie attributes for a new session.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` would drop the cookie on
 * top-level navigation from an external site, so following a link from an email
 * or from the CLI's browser hand-off would land the user on a logged-out page.
 * `Lax` still blocks the cross-site POST that CSRF depends on, and mutations
 * additionally carry a CSRF token.
 */
export function sessionCookie(token: string, maxAgeMs = SESSION_LIFETIME_MS): CookieOptions {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** Cookie attributes that clear the session cookie on logout. */
export function clearedSessionCookie(): CookieOptions {
  return { ...sessionCookie(''), maxAge: 0 };
}

/** Serialises cookie options into a `Set-Cookie` header value. */
export function serializeCookie(options: CookieOptions): string {
  return [
    `${options.name}=${options.value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'Secure',
    `SameSite=${options.sameSite}`,
  ].join('; ');
}
