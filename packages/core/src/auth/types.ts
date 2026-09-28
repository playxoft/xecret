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
 * The shape of a WorkOS user id: `user_` and an alphanumeric (ULID) tail.
 *
 * Stated once so the three places that check it — {@link workosIdentity}, the
 * linking pass, and the `users_workos_user_id_format_check` constraint in
 * migration 0018 — agree. A Firebase uid (28 bare alphanumerics) fails it,
 * which is the point. If WorkOS ever changes its id format, all three change
 * together, and the constraint needs a migration.
 */
export const WORKOS_USER_ID_PATTERN = /^user_[0-9A-Za-z]+$/;

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
 * `VerifiedIdentity` and the compiler had no way to object.
 *
 * ── Two halves, because the compiler alone is not enough ──
 * The unique-symbol brand is the compile-time half: a `VerifiedIdentity` does
 * not type-check as a `WorkosIdentity`. But `any` type-checks as anything —
 * `JSON.parse(...)` and `request.json()` return it — and a spread
 * (`{ ...identity, email }`) keeps the brand's *type* while being a new object
 * with new contents. So there is a runtime half too: {@link workosIdentity}
 * records every object it mints, frozen, in a module-private set, and
 * {@link isWorkosIdentity} asks that set. Nothing else can add to it, so a
 * parsed body, a JSON round-trip, a spread or an `as` cast is refused at
 * runtime even where the compiler let it through.
 *
 * `provider` is kept for logs and for the `provider?: never` guard on the
 * Firebase path's parameter; it proves nothing on its own.
 */
export type WorkosIdentity = VerifiedIdentity & {
  readonly provider: 'workos';
  readonly [workosAttested]: true;
};

/**
 * Every identity {@link workosIdentity} has minted. Module-private: the only
 * way in is through that function, which is what makes membership mean
 * "WorkOS attested to this, and nobody has changed it since" (the objects are
 * frozen). A WeakSet, so a minted identity is collected with its request.
 *
 * One caveat worth knowing: membership is per *module instance*. Were
 * `@xecret/core` ever bundled twice, identities minted by one copy would be
 * refused by the other — every WorkOS sign-in would fail, loudly. That is the
 * safe direction to be wrong in.
 */
const attested = new WeakSet<object>();

/**
 * Marks an identity as attested by WorkOS, and returns it frozen.
 *
 * Call it only on a user object WorkOS itself returned — the result of an
 * authenticated API call such as `authenticateWithCode` — never on anything a
 * client sent or another provider verified.
 *
 * The subject is checked against {@link WORKOS_USER_ID_PATTERN} as a last line
 * of defence against exactly the mix-up this type exists to prevent. A failure
 * is a verification failure, so the caller's existing mapping answers it with a
 * 401 rather than writing anything.
 */
export function workosIdentity(identity: VerifiedIdentity): WorkosIdentity {
  if (typeof identity.subject !== 'string' || !WORKOS_USER_ID_PATTERN.test(identity.subject)) {
    throw new IdentityVerificationError('malformed-subject');
  }
  const minted = Object.freeze({ ...identity, provider: 'workos' as const });
  attested.add(minted);
  return minted as WorkosIdentity;
}

/**
 * Whether `value` is an identity {@link workosIdentity} minted — the object
 * itself, not a copy of it.
 *
 * The runtime check behind the brand, for code that must not trust the
 * compiler's word for it: the linking pass calls it before anything else.
 */
export function isWorkosIdentity(value: unknown): value is WorkosIdentity {
  return typeof value === 'object' && value !== null && attested.has(value);
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
