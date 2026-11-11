import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { revokeCode } from '@/server/admin-service';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { isUuid } from '@/server/schemas/ids';

/**
 * `POST /api/admin/promo-codes/{codeId}/revoke` — no redemption or checkout
 * accepts the code from now on. Plans already granted with it keep their own
 * end dates; a discount already on a subscription stays for the cycles it was
 * given (Dodo's to end).
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { codeId: string };

export const POST = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  if (!isUuid(params.codeId)) throw errors.notFound('malformed promo code id');
  return json({ code: await revokeCode(services, admin, params.codeId) });
});
