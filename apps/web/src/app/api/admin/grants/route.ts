import { requireAdmin } from '@/server/admin';
import { listGrants } from '@/server/admin-service';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * `GET /api/admin/grants` — every complimentary plan and hand-made contract
 * in force, the soonest to end first.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  requireAdmin(services, principal);
  return json({ grants: await listGrants(services) });
});
