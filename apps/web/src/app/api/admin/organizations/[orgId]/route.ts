import { requireAdmin } from '@/server/admin';
import { organizationDetail } from '@/server/admin-monitoring';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * `GET /api/admin/organizations/{orgId}` — one organisation, as the list shows
 * it, and its members: address, name, role and when they joined. Counts of
 * what is in it, never what any of it is called.
 *
 * 404 for an id that is malformed, unknown, or a deleted organisation's. Not
 * written to the organisation's audit log — looking changes nothing — but to
 * the server's, with the admin's user id.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */

type Params = { orgId: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  return json(await organizationDetail(services, admin, params.orgId));
});
