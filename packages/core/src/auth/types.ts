/**
 * Authentication types.
 *
 * Firebase authenticates; xecret owns the session. See
 * docs/adr/0003-firebase-as-identity-provider.md for why the Firebase ID token
 * is used exactly once, at login, and never again.
 */

/** What an identity provider tells us about a user, after verification. */
export interface VerifiedIdentity {
  /** Stable, provider-scoped user identifier. Firebase calls this `uid`. */
  subject: string;
  email: string;
  emailVerified: boolean;
  /**
   * When the user last actually proved who they are, in **seconds since the
   * epoch** — Firebase's `auth_time`, not `iat`.
   *
   * The distinction is the whole value of the field. A refresh token mints a
   * fresh ID token every hour without anybody touching a keyboard, so `iat` says
   * only "this browser still holds a session". `auth_time` says "a password was
   * typed, or a passkey was tapped, at this moment", and that is the one question
   * a re-authentication gate is asking.
   *
   * Required, not optional. A provider that cannot attest when authentication
   * happened cannot back an irreversible action, and an absent field would
   * default to whatever the reader assumed — which on this path is a destruction
   * with no undo. Making it part of the interface means an alternative provider
   * has to answer the question rather than omit it.
   */
  authTime: number;
  displayName?: string | undefined;
  avatarUrl?: string | undefined;
}

/**
 * Verifies a credential issued by an external identity provider.
 *
 * The interface exists so Firebase is replaceable. A self-hoster who does not
 * want a Firebase project needs to implement exactly this, and nothing in
 * authorization, crypto, or the API changes.
 */
export interface IdentityProvider {
  /**
   * Verifies a provider token and returns the identity it attests to.
   *
   * Throws {@link IdentityVerificationError} on any failure. Implementations
   * must verify the signature, issuer, audience, and expiry — never merely
   * decode the token.
   */
  verify(token: string): Promise<VerifiedIdentity>;
}

/**
 * Raised when a provider credential cannot be verified.
 *
 * `reason` is for logs and metrics; it must never be returned to the client,
 * where it would tell an attacker which part of a forged token to fix.
 */
export class IdentityVerificationError extends Error {
  constructor(readonly reason: string) {
    super('Identity verification failed');
    this.name = 'IdentityVerificationError';
  }
}

/** An authenticated browser session, as resolved from a request cookie. */
export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** Why a session was not usable. Never surfaced verbatim to a client. */
export type SessionRejection = 'missing' | 'malformed' | 'unknown' | 'expired' | 'revoked';

export type SessionResolution =
  { ok: true; session: Session } | { ok: false; reason: SessionRejection };
