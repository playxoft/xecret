import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { vaultLockSchema } from '@/server/schemas/vault';
import { lockVault, primaryOrgId, requireUserPrincipal } from '@/server/vault-service';

/**
 * Locking on demand — the "I am walking away from this desk" button.
 *
 * Distinct from signing out, and worth having as its own action precisely
 * because it is cheap: locking costs one passphrase to undo, while signing out
 * costs a full trip through Firebase. Making the safe action the cheap one is
 * what gets it used.
 *
 * `everywhere` locks every session the account has, for a laptop left at an
 * office rather than one in front of you. It stops short of revoking, which is
 * what `DELETE /api/auth/sessions` is for — the difference is whether you expect
 * to get the device back.
 *
 * Deliberately *not* exempt from the lock gate. Locking an already-locked
 * session is a no-op, and an endpoint that a locked session could reach would be
 * one a stolen cookie could use to lock a colleague out of every device they
 * have open.
 */
export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  const body = (await parseJsonBody(request, vaultLockSchema)) ?? {};

  const locked = await lockVault(services, user, body.everywhere === true);

  // Audited, unlike a lock the idle timer fired: locking everywhere is a
  // security response — the act of somebody who thinks a device is in the wrong
  // hands — and the count is what tells a later reader how many devices that was.
  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'auth.locked',
        { type: 'user', id: user.user.id },
        { source: 'dashboard', sessionCount: locked },
      ),
    );
  }

  return json({ locked });
});
