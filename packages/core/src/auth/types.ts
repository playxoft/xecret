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
