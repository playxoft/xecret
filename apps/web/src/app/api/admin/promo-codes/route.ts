import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { createCode, listCodes } from '@/server/admin-service';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { adminPromoCodeCreateSchema } from '@/server/schemas/admin';

/**
 * The promo codes (migration 0035).
 *
 *  - `GET` — every code, newest first, with what it gives and whether it can
 *    still be used; and whether this deployment takes payments, which a
 *    discount code needs.
 *  - `POST` — a new code: a free plan an owner redeems in the app, or a
 *    discount checkout applies. A discount code is created at Dodo too,
 *    restricted to this deployment's own products.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

export const GET = authenticatedRoute(async ({ principal, services }) => {
  requireAdmin(services, principal);
  return json(await listCodes(services));
});

export const POST = authenticatedRoute(async ({ request, principal, services }) => {
  const admin = requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  const body = await parseJsonBody(request, adminPromoCodeCreateSchema);
  return json({ code: await createCode(services, admin, body) }, { status: 201 });
});
