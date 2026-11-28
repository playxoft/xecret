import { requireAdmin } from '@/server/admin';
import { listOrganizations } from '@/server/admin-monitoring';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { adminOrganizationsQuerySchema } from '@/server/schemas/admin';

/**
 * `GET /api/admin/organizations` — every live organisation, newest first, a
 * page at a time (`?cursor=`, `?limit=` up to 100): what it is on, how it is
 * billed, who owns it, and how many members, open invitations, projects,
 * environments and secrets it has — counts, never names.
 *
 * `GET /api/admin/organizations?q=` — the search: the organisations a person
 * is in, by their address, or the one organisation with an id, or with a
 * legacy slug. The same row, and never paged.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */
export const GET = authenticatedRoute(async ({ request, principal, services }) => {
  const admin = await requireAdmin(services, principal);
  const query = parseQuery(request, adminOrganizationsQuerySchema);
  return json(await listOrganizations(services, admin, query));
});
