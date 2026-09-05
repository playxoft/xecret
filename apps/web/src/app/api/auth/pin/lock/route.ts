import * as z from 'zod/mini';
import { lockSessions } from '@xecret/db/repositories';
import { json, parseJsonBody } from '@/server/http';
import { primaryOrgId, requireUserPrincipal } from '@/server/pin-service';
import { authenticatedRoute } from '@/server/route';

/**
 * Locking on demand — the "I am walking away from this desk" button.
 *
 * Distinct from signing out, and worth having as its own action precisely
 * because it is cheap: locking costs one PIN to undo, while signing out costs a
 * full trip through Firebase. Making the safe action the cheap one is what gets
 * it used.
 *
 * `everywhere` locks every session the account has, for a laptop left at an
 * office rather than one in front of you. It stops short of revoking, which is
 * what `DELETE /api/auth/sessions` is for — the difference is whether you expect
 * to get the device back.
 */

// The body is optional: locking this session is the overwhelmingly common case,
// and requiring `{}` for it would be ceremony.
const lockRequest = z.optional(
  z.object({
    everywhere: z.optional(z.boolean()),
  }),
);

export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  const body = (await parseJsonBody(request, lockRequest)) ?? {};

  const locked = await lockSessions(
    services.db,
    body.everywhere === true ? { userId: user.user.id } : { sessionId: user.sessionId },
  );

  // Audited, unlike a successful unlock: locking everywhere is a security
  // response — the act of somebody who thinks a device is in the wrong hands —
  // and the count is what tells a later reader how many devices that was.
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
