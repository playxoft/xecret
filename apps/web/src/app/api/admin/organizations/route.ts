import { requireAdmin } from '@/server/admin';
import { searchOrganizations } from '@/server/admin-service';
import { json, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { adminSearchQuerySchema } from '@/server/schemas/admin';

/**
 * `GET /api/admin/organizations?q=` — the organisations a person is in, by
 * their address, or the one organisation with a slug: what it is on, how it is
 * billed, and any complimentary plan it has.
 *
 * xecret's admins only (`server/admin.ts`); 404 to everybody else.
 */
export const GET = authenticatedRoute(async ({ request, principal, services }) => {
  requireAdmin(services, principal);
  const { q } = parseQuery(request, adminSearchQuerySchema);
  return json({ organizations: await searchOrganizations(services, q) });
});
