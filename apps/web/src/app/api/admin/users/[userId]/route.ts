import { requireAdmin } from '@/server/admin';
import { accountDetail } from '@/server/admin-monitoring';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * `GET /api/admin/users/{userId}` — one account, as the list shows it, and the
 * live organisations it is in, with its role in each.
 *
 * 404 for an id that is malformed, unknown, or a deleted account's.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { userId: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  return json(await accountDetail(services, admin, params.userId));
});
