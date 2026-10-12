import type { FirebaseExportUser } from './firebase-export';
import type { CreateWorkosUserInput, WorkosUserSummary } from './workos-api';

/**
 * What the Firebase → WorkOS import does with each user, decided without any
 * I/O so that every rule below is unit-tested.
 *
 * ── The rules (plan §6; PR #100 "For WS-2" items 6, 9, 12) ──
 *
 * 1. **No address → skipped.** WorkOS users are keyed by email.
 * 2. **Disabled → skipped.** WorkOS has no disabled state, so importing a
 *    Firebase account an operator switched off would switch it back on. The
 *    person is reported by uid for a human to decide.
 * 3. **Unverified address → skipped**, not imported without a password. The
 *    plan allows either; skipping is the stricter. Whoever registered an
 *    address they do not own must not end up holding a WorkOS User for it —
 *    with a known password that is a pre-account-takeover, and even without
 *    one it is a record the real owner later collides with. Nothing is lost:
 *    the Firebase sign-in refuses unverified addresses, so such a user has no
 *    xecret account, and the real owner signs up fresh.
 * 4. **Verified, with a password → imported with its Firebase scrypt hash.**
 *    The same password keeps working.
 * 5. **Verified, no password (Google-only, or another provider) → imported
 *    without one.** WorkOS attaches their Google credential to this user at
 *    their first Google sign-in, once Google OAuth is configured in WorkOS
 *    with the Firebase project's OAuth client (plan §8 Q1).
 *
 * ── Idempotency ({@link decideImport}) ──
 * Every imported user carries `external_id = firebase uid`, unique per WorkOS
 * environment. A re-run finds them by it. An address already held in WorkOS by
 * a *verified* user nobody imported is reused, never duplicated or written to;
 * held by anybody else, it is a conflict to report, never overwritten.
 */

export type SkipReason = 'no-email' | 'disabled' | 'email-unverified' | 'malformed-password';

/** How an imported user will sign in. */
export type ImportKind = 'password' | 'google-only' | 'other-provider-only';

export interface ImportCandidate {
  readonly uid: string;
  readonly email: string;
  readonly kind: ImportKind;
  readonly firstName?: string;
  readonly lastName?: string;
  /** Present exactly when `kind` is `password`. */
  readonly password: { readonly hash: Uint8Array; readonly salt: Uint8Array } | null;
}

export type Classification =
  | { readonly action: 'skip'; readonly uid: string; readonly reason: SkipReason }
  | { readonly action: 'import'; readonly candidate: ImportCandidate };

/** WorkOS's ceiling on `external_id`. A Firebase-minted uid is 28 characters. */
export const WORKOS_EXTERNAL_ID_MAX_LENGTH = 64;

/**
 * First and last name from a Firebase display name.
 *
 * WorkOS stores the two separately; Firebase has one free-text field. The first
 * word is the first name and the rest is the last name — wrong for some
 * naming conventions, and harmless: these fields are display only, and the
 * user can change them. Control characters are dropped and whitespace
 * collapsed, so a name cannot smuggle a line break into a log or an email.
 */
export function splitDisplayName(displayName: string | null | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const words = (displayName ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const [first, ...rest] = words;
  if (first === undefined) return {};
  return rest.length === 0 ? { firstName: first } : { firstName: first, lastName: rest.join(' ') };
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Whether two addresses are the same mailbox, under ASCII-only case folding.
 *
 * The linking pass's rule (PR #100 judgement call 4), for the same reason: a
 * Unicode case fold can map a lookalike onto a real address (the Kelvin sign
 * folds to `k`), so non-ASCII addresses must match exactly. Over-strict means a
 * reported conflict; over-lenient would mean the wrong person's account.
 */
export function sameAddress(a: string, b: string): boolean {
  if (isAscii(a) && isAscii(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function classifyFirebaseUser(user: FirebaseExportUser): Classification {
  const { uid } = user;
  if (user.email === null) return { action: 'skip', uid, reason: 'no-email' };
  if (user.disabled) return { action: 'skip', uid, reason: 'disabled' };
  if (!user.emailVerified) return { action: 'skip', uid, reason: 'email-unverified' };
  // Never "import it without the password instead": that would silently turn
  // somebody's working password into a reset they did not ask for.
  if (user.password === 'malformed') return { action: 'skip', uid, reason: 'malformed-password' };

  const google = user.providers.find((p) => p.providerId === 'google.com');
  const kind: ImportKind =
    user.password !== null ? 'password' : google ? 'google-only' : 'other-provider-only';
  // A Google user often has no top-level display name of their own; Google's is
  // on the provider record.
  const name = splitDisplayName(user.displayName ?? google?.displayName ?? null);
  return {
    action: 'import',
    candidate: { uid, email: user.email, kind, ...name, password: user.password },
  };
}

export type ConflictReason =
  /** The user holding this uid as `external_id` has a different address now. */
  | 'external-id-email-mismatch'
  /** The user holding this uid as `external_id` is not verified. */
  | 'imported-user-unverified'
  /** The address belongs to a WorkOS user linked to a different external id. */
  | 'email-held-by-other-identity'
  /** The address belongs to an unverified WorkOS user nobody imported. */
  | 'email-held-by-unverified-user'
  /**
   * The lookup by address returned a user whose address is not this one under
   * ASCII-only folding (a Unicode lookalike, or WorkOS normalising differently).
   * Never reused: the mapping would otherwise point at somebody else's mailbox.
   */
  | 'email-lookup-mismatch';

export type ImportDecision =
  | { readonly action: 'create' }
  /** Found by `external_id`: an earlier run made it. */
  | { readonly action: 'already-imported'; readonly workosUserId: string }
  /**
   * A verified WorkOS user with this address that no import made (they signed
   * up directly). Mapped, and not written to: no password, no `external_id`.
   */
  | { readonly action: 'reuse-existing'; readonly workosUserId: string }
  | {
      readonly action: 'conflict';
      readonly reason: ConflictReason;
      readonly workosUserId: string;
    };

/**
 * What to do given what WorkOS already holds: the user whose `external_id` is
 * this uid (looked up first), else the user holding this address.
 *
 * Why an existing *unverified* holder is a conflict rather than reused: the
 * mapping is what the backfill writes into `users.workos_user_id`, and an
 * unverified WorkOS User may carry a password somebody else set. Linking it is
 * the same pre-account-takeover the unverified-skip rule closes, from the
 * other side. Why a verified holder is reused: WorkOS has proven they own the
 * inbox, which is exactly what the linking pass adopts an account on (§5
 * step 2), so the mapping records what their first sign-in would do anyway.
 */
export function decideImport(
  candidate: Pick<ImportCandidate, 'uid' | 'email'>,
  byExternalId: WorkosUserSummary | null,
  byEmail: WorkosUserSummary | null,
): ImportDecision {
  const imported =
    byExternalId ?? (byEmail !== null && byEmail.externalId === candidate.uid ? byEmail : null);
  if (imported !== null) {
    if (!sameAddress(imported.email, candidate.email)) {
      return {
        action: 'conflict',
        reason: 'external-id-email-mismatch',
        workosUserId: imported.id,
      };
    }
    if (!imported.emailVerified) {
      return { action: 'conflict', reason: 'imported-user-unverified', workosUserId: imported.id };
    }
    return { action: 'already-imported', workosUserId: imported.id };
  }
  if (byEmail === null) return { action: 'create' };
  if (!sameAddress(byEmail.email, candidate.email)) {
    return { action: 'conflict', reason: 'email-lookup-mismatch', workosUserId: byEmail.id };
  }
  if (byEmail.externalId !== null) {
    return { action: 'conflict', reason: 'email-held-by-other-identity', workosUserId: byEmail.id };
  }
  if (!byEmail.emailVerified) {
    return {
      action: 'conflict',
      reason: 'email-held-by-unverified-user',
      workosUserId: byEmail.id,
    };
  }
  return { action: 'reuse-existing', workosUserId: byEmail.id };
}

/**
 * The Create User request for a candidate. Always `email_verified: true` —
 * only verified users are imported — and `external_id` is the Firebase uid
 * (omitted only for a uid longer than WorkOS allows, which a Firebase-minted
 * uid never is; the import then still finds the user again by address).
 */
export function buildCreateUserInput(
  candidate: ImportCandidate,
  firebaseScryptHash: string | null,
): CreateWorkosUserInput {
  if ((candidate.kind === 'password') !== (firebaseScryptHash !== null)) {
    throw new TypeError('A password user needs its hash, and only a password user may have one.');
  }
  return {
    email: candidate.email,
    emailVerified: true,
    ...(candidate.firstName !== undefined ? { firstName: candidate.firstName } : {}),
    ...(candidate.lastName !== undefined ? { lastName: candidate.lastName } : {}),
    ...(candidate.uid.length <= WORKOS_EXTERNAL_ID_MAX_LENGTH ? { externalId: candidate.uid } : {}),
    ...(firebaseScryptHash !== null ? { firebaseScryptHash } : {}),
  };
}
