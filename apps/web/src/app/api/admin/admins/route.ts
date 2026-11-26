import { actorId } from '@/server/actor';
import { requireAdmin } from '@/server/admin';
import { addAdmin, listAdmins } from '@/server/admin-users';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { adminAddSchema } from '@/server/schemas/admin';

/**
 * xecret's admins (migration 0035).
 *
 *  - `GET` — who they are, who added each, and when.
 *  - `POST` — makes an existing, verified account an admin, by the address it
 *    signs in with. Every admin is emailed about it.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

export const GET = authenticatedRoute(async ({ principal, services }) => {
  const admin = await requireAdmin(services, principal);
  return json({ admins: await listAdmins(services, admin) });
});

export const POST = authenticatedRoute(async ({ request, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));
  const { email } = await parseJsonBody(request, adminAddSchema);
  return json({ admin: await addAdmin(services, admin, email) }, { status: 201 });
});
