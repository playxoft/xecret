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

/** Only this module can name it, so only {@link workosIdentity} can mint the brand. */
declare const workosAttested: unique symbol;

/**
 * An identity WorkOS attested to: `subject` is a WorkOS user id (`user_…`).
 *
 * ── Why a distinct type, when the fields are the same ──
 * `subject` means a different thing per provider, and the two meanings must
 * never cross. The WorkOS linking pass (`upsertUserFromWorkosIdentity`) writes
 * `subject` into `users.workos_user_id` and adopts accounts by verified email;
 * handing it a Firebase identity writes a Firebase uid where a WorkOS id
 * belongs, and the first real WorkOS login for that person then collides with
 * it. That happened once, in review, because both functions took a plain
 * `VerifiedIdentity` and the compiler had no way to object. With the brand, a
 * `VerifiedIdentity` from the Firebase verifier does not type-check as an
 * argument to the linker at all.
 *
 * `provider` is the runtime half, for logs and for the `provider?: never` guard
 * on the Firebase path; the unique-symbol brand is the compile-time half, and it
 * is what makes {@link workosIdentity} the only way to produce one.
 */
export type WorkosIdentity = VerifiedIdentity & {
  readonly provider: 'workos';
  readonly [workosAttested]: true;
};

/**
 * Marks an identity as attested by WorkOS.
 *
 * Call it only on a user object WorkOS itself returned — the result of an
 * authenticated API call such as `authenticateWithCode` — never on anything a
 * client sent or another provider verified.
 *
 * The subject is checked against WorkOS's documented `user_` prefix as a last
 * line of defence against exactly the mix-up this type exists to prevent: a
 * Firebase uid is 28 bare alphanumerics and fails it. A failure is a
 * verification failure, so the caller's existing mapping answers it with a 401
 * rather than writing anything.
 */
export function workosIdentity(identity: VerifiedIdentity): WorkosIdentity {
  if (!/^user_[0-9A-Za-z]+$/.test(identity.subject)) {
    throw new IdentityVerificationError('malformed-subject');
  }
  return { ...identity, provider: 'workos' } as WorkosIdentity;
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
