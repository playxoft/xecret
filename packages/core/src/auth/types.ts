/**
 * Authentication types.
 *
 * WorkOS authenticates; xecret owns the session. See
 * docs/adr/0010-workos-as-identity-provider.md for why the provider's answer is
 * used exactly once, at the sign-in callback, and never again: the authorization
 * code is exchanged, the identity it names is resolved to a user row, and the
 * WorkOS tokens that came with it are discarded in favour of an xecret session.
 */

/** What an identity provider tells us about a user, after verification. */
export interface VerifiedIdentity {
  /** Stable, provider-scoped user identifier. For WorkOS, the user id (`user_…`). */
  subject: string;
  email: string;
  emailVerified: boolean;
  /**
   * When the user last actually proved who they are, in **seconds since the
   * epoch**.
   *
   * For an authorization-code exchange this is the moment of the exchange: a
   * code is minted by an authentication that has just happened, it lives ten
   * minutes, and it can be exchanged once. That is an honest answer to "when did
   * this person authenticate" for the sign-in it completes, and it is the only
   * consumer — nothing reads this field after the session is issued.
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
 * `provider` is kept for logs; it proves nothing on its own.
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
 * ── Built, then validated, then frozen — in that order ──
 * The result is an object built here, field by field, from exactly the fields
 * a `VerifiedIdentity` has. Each is read **once**, and only as an **own**
 * property of the input. Then that copy — the object that will be recorded —
 * is validated, never the input. That order closes two holes a spread-then-
 * check left open:
 *
 *  - An input *missing* a field no longer falls through to `Object.prototype`
 *    later. The copy always has every field as its own property, and a missing
 *    `emailVerified` is `undefined` here, which fails validation. (With a
 *    spread, the minted object lacked it, and the linker's read of
 *    `identity.emailVerified` found whatever a polluted `Object.prototype`
 *    said.)
 *  - A getter cannot answer the check with one value and the copy with
 *    another, because there is only one read, and what is checked is what was
 *    copied.
 *
 * Anything else on the input — an `organizationId`, an `isAdmin`, a
 * `provider` of its own — is not copied at all.
 *
 * The subject must match {@link WORKOS_USER_ID_PATTERN}: a last line of defence
 * against exactly the mix-up this type exists to prevent. A failure of any
 * check is a verification failure, so the caller's existing mapping answers it
 * with a 401 rather than writing anything.
 */
export function workosIdentity(identity: VerifiedIdentity): WorkosIdentity {
  const own = (key: keyof VerifiedIdentity): unknown =>
    Object.hasOwn(identity, key) ? identity[key] : undefined;

  const minted = {
    subject: own('subject'),
    email: own('email'),
    emailVerified: own('emailVerified'),
    authTime: own('authTime'),
    displayName: own('displayName'),
    avatarUrl: own('avatarUrl'),
    provider: 'workos' as const,
  };

  if (typeof minted.subject !== 'string' || !WORKOS_USER_ID_PATTERN.test(minted.subject)) {
    throw new IdentityVerificationError('malformed-subject');
  }
  if (
    typeof minted.email !== 'string' ||
    minted.email === '' ||
    typeof minted.emailVerified !== 'boolean' ||
    typeof minted.authTime !== 'number' ||
    !Number.isFinite(minted.authTime) ||
    !(minted.displayName === undefined || typeof minted.displayName === 'string') ||
    !(minted.avatarUrl === undefined || typeof minted.avatarUrl === 'string')
  ) {
    throw new IdentityVerificationError('malformed-identity');
  }

  Object.freeze(minted);
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
 * What one authorization-code exchange establishes.
 *
 * The identity, and the four facts about *this* sign-in that the callback
 * decides on and that the identity alone cannot carry: which organisation's
 * connection it came through (if any), how the person authenticated, when they
 * last actually did, and whether somebody else is acting as them.
 */
export interface AuthorizationCodeExchange<Identity extends VerifiedIdentity = VerifiedIdentity> {
  identity: Identity;
  /**
   * The provider's organisation for this sign-in, or `null`.
   *
   * **Not proof the sign-in came through that organisation's identity
   * provider.** AuthKit returns one after organisation *selection* in password
   * and OAuth sign-ins too. Anything that grants or enforces on the strength of
   * an organisation must also require `authenticationMethod === 'SSO'`.
   */
  organizationId: string | null;
  /** e.g. `SSO`, `Password`, `GoogleOAuth`. `null` when the provider did not say. */
  authenticationMethod: string | null;
  /**
   * When the person last *actively* authenticated at the provider — entered a
   * password, used a passkey, went through Google or their identity provider —
   * in seconds since the epoch, or `null` when the provider did not say.
   *
   * Not the moment of the exchange: a provider that reused a session it already
   * held, without asking for anything, mints a code whose `authenticatedAt` is
   * that session's original sign-in. That difference is what the vault reset's
   * first lock checks (`server/sign-in.ts`); nothing else reads it.
   */
  authenticatedAt: number | null;
  /**
   * Set when a provider administrator is signing in *as* this user. Refused by
   * the callback; carried so that the refusal can name who tried.
   */
  impersonator: { email: string } | null;
}

/** Request facts a provider may forward for its own risk checks. */
export interface CodeExchangeContext {
  /** The PKCE verifier the authorization request committed to. */
  codeVerifier: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Exchanges an authorization code for the identity it attests to.
 *
 * The interface exists so the provider is replaceable. A self-hoster who does
 * not want a WorkOS account needs to implement exactly this — an authorization
 * endpoint that redirects back with a code, and this exchange — and nothing in
 * sessions, authorization, crypto or the API changes.
 */
export interface IdentityProvider<Identity extends VerifiedIdentity = VerifiedIdentity> {
  /**
   * Throws {@link IdentityVerificationError} for a code the provider refused.
   * Implementations exchange the code with the provider over an authenticated
   * call — never decode a token the browser handed over.
   */
  exchangeCode(
    code: string,
    context: CodeExchangeContext,
  ): Promise<AuthorizationCodeExchange<Identity>>;
}

/**
 * Raised when a provider credential cannot be verified.
 *
 * `reason` is for logs and metrics; it must never be returned to the client,
 * where it would tell an attacker which part of a forged credential to fix.
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
