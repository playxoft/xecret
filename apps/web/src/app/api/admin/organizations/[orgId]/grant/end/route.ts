import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { endGrant } from '@/server/admin-service';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { adminEndGrantSchema } from '@/server/schemas/admin';
import { isUuid } from '@/server/schemas/ids';

/**
 * `POST /api/admin/organizations/{orgId}/grant/end` — ends a complimentary
 * plan now. The organisation returns to Free; nothing is deleted, and nobody
 * already seated loses their seat. The reason goes into its audit log.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { orgId: string };

export const POST = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  if (!isUuid(params.orgId)) throw errors.notFound('malformed organisation id');

  const { reason } = await parseJsonBody(request, adminEndGrantSchema);
  return json({ organization: await endGrant(services, admin, params.orgId, reason) });
});
