import {
  checkPin,
  clearedPinFailures,
  evaluatePinLockout,
  hashPin,
  isSessionUnlocked,
  nextPinFailure,
  pinNeedsRehash,
  unlockExpiryFrom,
  verifyPin,
} from '@xecret/core/auth';
import {
  findPinForUser,
  listOrganizationsForUser,
  markSessionUnlocked,
  recordPinAttempt,
  rehashPin,
  upsertPin,
} from '@xecret/db/repositories';
import type { PinRecord } from '@xecret/db/repositories';
import { errors } from './errors';
import type { Principal } from './actor';
import type { ServiceContext } from './context';

/**
 * The PIN operations, in one place.
 *
 * The routes above this are thin on purpose: unlocking is the one flow in the
 * product where the order of operations is itself the security control, and
 * spreading it across three handlers is how a step gets reordered by somebody
 * who does not know why it was where it was.
 *
 * The order below, and why each step is where it is:
 *
 *  1. **Load the record.** A user with no PIN cannot be unlocked, and must not
 *     be told apart from one whose PIN is wrong by timing alone.
 *  2. **Check the lockout before comparing.** Comparing first would let an
 *     attacker keep guessing during a lockout and simply ignore the response —
 *     and PBKDF2 at 600k iterations is a denial-of-service amplifier if it can
 *     be triggered without limit.
 *  3. **Compare.** Constant-time, inside `verifyPin`.
 *  4. **Record the outcome before answering.** A failure that is not durably
 *     counted is a free guess, so the write happens before the response —
 *     not in `waitUntil`, which would let a client that disconnects early
 *     guess without cost.
 *  5. **Only then unlock the session.**
 */

/** What the dashboard needs to decide between the setup screen and the lock screen. */
export interface PinStatus {
  /** Whether this account has a PIN at all. */
  configured: boolean;
  unlocked: boolean;
  /** When the current unlock lapses. `null` when locked. */
  unlockedUntil: string | null;
}

export async function pinStatus(
  services: ServiceContext,
  principal: Principal,
  now = new Date(),
): Promise<PinStatus> {
  // A bearer credential is never locked and has no PIN to set — reporting it as
  // "configured: false" would send the CLI into a setup flow it has no screen
  // for. See `isUnlocked` in `actor.ts`.
  if (principal.kind !== 'user') {
    return { configured: true, unlocked: true, unlockedUntil: null };
  }

  const record = await findPinForUser(services.db, principal.user.id);
  const unlocked = isSessionUnlocked(principal.pinVerifiedAt, now);

  return {
    configured: record !== null,
    unlocked,
    unlockedUntil:
      unlocked && principal.pinVerifiedAt !== null
        ? unlockExpiryFrom(principal.pinVerifiedAt).toISOString()
        : null,
  };
}

/**
 * The organisation an account-level audit record is filed under.
 *
 * `audit_logs.org_id` is NOT NULL, and a PIN is not org-scoped — one PIN covers
 * every organisation a person belongs to. So the record goes to their primary
 * membership, with the same honest limitation logout has: a member of several
 * organisations produces one record rather than one per organisation. Writing it
 * N times would be worse, because it would read as N separate acts.
 *
 * `null` when the account has no memberships, which is reachable only after
 * every one has been revoked. The act then goes unrecorded rather than blocking.
 */
export async function primaryOrgId(
  services: ServiceContext,
  userId: string,
): Promise<string | null> {
  const memberships = await listOrganizationsForUser(services.db, userId);
  const primary = memberships[0];
  return primary ? primary.organization.id : null;
}

/** The session principal, or a refusal for a credential that cannot hold a PIN. */
export function requireUserPrincipal(principal: Principal): Extract<Principal, { kind: 'user' }> {
  if (principal.kind !== 'user') {
    throw errors.forbidden('A PIN belongs to a browser session, not to a token.');
  }
  return principal;
}

/**
 * Sets a PIN, requiring the current one when there already is one.
 *
 * The `currentPin` requirement is what stops the lock from being bypassable by
 * the thing it protects against: without it, somebody at an unattended laptop
 * would simply set a new PIN and be in. It is waived only when no PIN exists,
 * which is a state a session reaches exactly once.
 */
export async function setPin(
  services: ServiceContext,
  principal: Extract<Principal, { kind: 'user' }>,
  params: { pin: string; currentPin?: string | undefined },
): Promise<void> {
  const existing = await findPinForUser(services.db, principal.user.id);

  if (existing !== null) {
    if (params.currentPin === undefined) {
      throw errors.badRequest('Enter your current PIN to change it.');
    }
    // Goes through the same lockout and counting as an unlock. A change form
    // that did not would be an unmetered oracle for guessing the current PIN.
    await assertPinMatches(services, principal.user.id, existing, params.currentPin);
  }

  const check = checkPin(params.pin);
  if (!check.valid) {
    throw errors.validation([
      { field: 'pin', message: check.message ?? 'That PIN cannot be used.' },
    ]);
  }

  await upsertPin(services.db, principal.user.id, await hashPin(params.pin));

  // Setting a PIN unlocks the session that set it. The user has just proved
  // presence twice over — they were signed in and they chose the PIN — and
  // sending them straight to a lock screen to retype what they typed a second
  // ago is friction with no corresponding gain.
  await markSessionUnlocked(services.db, principal.sessionId, new Date());
}

/**
 * Verifies a PIN and unlocks the session.
 *
 * Returns when the unlock lapses, so the client can schedule its own re-lock
 * rather than discovering the expiry through a failed request mid-edit.
 */
export async function unlockSession(
  services: ServiceContext,
  principal: Extract<Principal, { kind: 'user' }>,
  pin: string,
): Promise<{ unlockedUntil: string }> {
  const record = await findPinForUser(services.db, principal.user.id);
  if (record === null) {
    throw errors.badRequest('This account has no PIN yet. Set one to continue.');
  }

  await assertPinMatches(services, principal.user.id, record, pin);

  const now = new Date();
  await markSessionUnlocked(services.db, principal.sessionId, now);

  return { unlockedUntil: unlockExpiryFrom(now).toISOString() };
}

/**
 * Compares a PIN, enforcing and updating the lockout around it.
 *
 * Throws on failure and returns nothing on success — a boolean return would let
 * a caller forget to check it, and the one caller that forgot would be the one
 * that unlocks a session.
 */
async function assertPinMatches(
  services: ServiceContext,
  userId: string,
  record: PinRecord,
  pin: string,
): Promise<void> {
  const now = new Date();

  const lockout = evaluatePinLockout(record, now);
  if (lockout.locked) throw errors.pinLocked(lockout.retryAfterMs);

  const matched = await verifyPin(pin, record.pinHash);

  if (!matched) {
    // Awaited, not deferred. A failure recorded in `waitUntil` is one a client
    // can avoid paying for by hanging up, which turns the counter into a
    // suggestion.
    await recordPinAttempt(services.db, userId, nextPinFailure(record, now));

    console.warn('pin attempt failed', {
      requestId: services.meta.requestId,
      // The count, never the PIN and never the user's email.
      failedAttempts: record.failedAttempts + 1,
    });

    throw errors.unauthenticated('incorrect pin');
  }

  if (record.failedAttempts !== 0 || record.lockedUntil !== null) {
    await recordPinAttempt(services.db, userId, clearedPinFailures());
  }

  // Raising `PBKDF2_ITERATIONS` upgrades accounts as their owners use them,
  // rather than through a migration that would have to know every PIN. Deferred:
  // the user is already through, and re-deriving costs as much as the check did.
  if (pinNeedsRehash(record.pinHash)) {
    services.waitUntil(
      hashPin(pin)
        .then((upgraded) => rehashPin(services.db, userId, upgraded))
        .catch(() => {
          // Best effort by design. The row keeps verifying at its old cost, so
          // a failure here costs nothing except the upgrade, and there is
          // nobody left to tell.
        }),
    );
  }
}
