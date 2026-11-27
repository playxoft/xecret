import { requireAdmin } from '@/server/admin';
import { listAccounts } from '@/server/admin-monitoring';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { adminUsersQuerySchema } from '@/server/schemas/admin';

/**
 * `GET /api/admin/users` — every live account, newest first, a page at a time
 * (`?cursor=`, `?limit=` up to 100); with `?q=`, those whose address contains
 * it, in any case. The account data only: address, name, when it signed up and
 * last signed in, whether the address is verified, how its latest session
 * signed in, and how many organisations it is in.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */
export const GET = authenticatedRoute(async ({ request, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  const query = parseQuery(request, adminUsersQuerySchema);
  return json(await listAccounts(services, admin, query));
});
