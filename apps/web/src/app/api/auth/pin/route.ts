import * as z from 'zod/mini';
import { isAutoLockMinutes, PIN_LENGTH } from '@xecret/core/auth';
import { setAutoLockMinutes } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { pinStatus, primaryOrgId, requireUserPrincipal, setPin } from '@/server/pin-service';
import { attemptKey, enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * Setting and changing the unlock PIN.
 *
 * `allowLocked` because a session that has never been unlocked is exactly the
 * session that needs to set the first PIN. Changing an existing one still
 * requires the current PIN — see `setPin` — so the exemption widens nothing:
 * without the current PIN this route can only act on an account that has none.
 */

const pin = z
  .string()
  .check(
    z.length(PIN_LENGTH, `Your PIN must be exactly ${PIN_LENGTH} digits.`),
    z.regex(/^\d+$/, 'Your PIN must be digits only.'),
  );

const setPinRequest = z.object({
  pin,
  /** Required when the account already has a PIN; ignored when it does not. */
  currentPin: z.optional(pin),
});

export const GET = authenticatedRoute(
  async ({ principal, services }) => json({ pin: await pinStatus(services, principal) }),
  { allowLocked: true },
);

export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    // Against the login bucket, keyed on the user: changing a PIN requires the
    // current one, so this endpoint is a guessing surface exactly like unlock
    // and must not be handed its own, more generous allowance.
    await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

    const body = await parseJsonBody(request, setPinRequest);

    // Read before the write, so the audit record can say which act this was.
    // Afterwards the two are indistinguishable.
    const before = await pinStatus(services, principal);

    await setPin(services, user, {
      pin: body.pin,
      ...(body.currentPin === undefined ? {} : { currentPin: body.currentPin }),
    });

    // Filed against the user's primary organisation, for the same reason logout
    // is: `audit_logs.org_id` is NOT NULL, because a record nobody's audit view
    // can reach is a record nobody will read.
    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          before.configured ? 'auth.pin_changed' : 'auth.pin_set',
          { type: 'user', id: user.user.id },
          { source: 'dashboard' },
        ),
      );
    }

    // Reported from the principal as it now is: `setPin` unlocked the session,
    // and echoing the stale `before` would tell the client it is still locked.
    return json({ pin: await pinStatus(services, { ...user, pinVerifiedAt: new Date() }) });
  },
  { allowLocked: true },
);

const autoLockRequest = z.object({
  /** One of `AUTO_LOCK_MINUTES_OPTIONS`; `0` disables the idle lock. */
  autoLockMinutes: z
    .int()
    .check(z.refine(isAutoLockMinutes, 'Choose one of the offered auto-lock intervals.')),
});

/**
 * Changes how long the dashboard may sit idle before locking itself.
 *
 * *Not* exempt from the lock gate, unlike GET and POST: this route only tunes
 * a protection, and a locked session has no business loosening one. It changes
 * no PIN and unlocks nothing, so it takes the ordinary mutation allowance
 * rather than the login bucket — it is not a guessing surface.
 *
 * Audited: setting the interval to "never" is the act an incident review
 * wants to see dated, because it is how an unlocked laptop stays unlocked.
 */
export const PATCH = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const body = await parseJsonBody(request, autoLockRequest);

  const updated = await setAutoLockMinutes(services.db, user.user.id, body.autoLockMinutes);
  // No PIN row: there is nothing an idle lock could ask for. The setup
  // screen is the answer, not a silently created preference.
  if (updated === null) {
    throw errors.badRequest('Set a PIN first; auto-lock asks for it.');
  }

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'auth.autolock_changed',
        { type: 'user', id: user.user.id },
        {
          source: 'dashboard',
          reason:
            body.autoLockMinutes === 0 ? 'never' : `after ${body.autoLockMinutes} minutes idle`,
        },
      ),
    );
  }

  return json({ pin: await pinStatus(services, principal) });
});

/**
 * Removing a PIN is deliberately not offered.
 *
 * A PIN that can be deleted from an unlocked session stops protecting the laptop
 * the moment somebody sits at it during the unlock window — which is the exact
 * scenario the lock exists for. An account that wants to stop using one signs
 * out on that device instead.
 */
export const DELETE = authenticatedRoute(async () => {
  throw errors.badRequest('A PIN cannot be removed. Change it, or sign out on this device.');
});
