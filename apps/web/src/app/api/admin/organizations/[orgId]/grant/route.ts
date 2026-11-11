import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { grantPlan } from '@/server/admin-service';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { adminGrantSchema } from '@/server/schemas/admin';
import { isUuid } from '@/server/schemas/ids';

/**
 * `POST /api/admin/organizations/{orgId}/grant` — gives an organisation a
 * complimentary plan, or replaces the one it has: the plan, an optional seat
 * ceiling, an optional end date, and the admin's reason, which goes into the
 * organisation's own audit log.
 *
 * Over an organisation Dodo bills, refused unless `overDodo` says to take it
 * off its subscription — which keeps billing at Dodo until somebody cancels
 * it there, so its id is answered for the admin to do that.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { orgId: string };

export const POST = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  if (!isUuid(params.orgId)) throw errors.notFound('malformed organisation id');

  const body = await parseJsonBody(request, adminGrantSchema);
  return json(await grantPlan(services, admin, params.orgId, body));
});
