import { requireAdmin } from '@/server/admin';
import { adminOverview } from '@/server/admin-monitoring';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * `GET /api/admin/overview` — how many live accounts, organisations,
 * projects, environments and secrets there are (each counted only inside live
 * parents), and how many accounts signed up in the last seven and thirty days.
 *
 * Asked when an admin opens the page, never on a timer.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  const admin = await requireAdmin(services, principal);
  return json(await adminOverview(services, admin));
});
