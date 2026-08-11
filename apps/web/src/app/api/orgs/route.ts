import { listOrganizationsForUser } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toOrganization } from '@/server/schemas/resources';

/**
 * The organisations the caller can act in.
 *
 * This is what the dashboard's organisation switcher reads and what the CLI uses
 * to resolve `--org`. Every other route in this tree takes an `{orgSlug}` and
 * resolves it through `tenancy.ts`; this one has no slug to resolve, because it
 * is the route that tells the client which slugs exist for them.
 *
 * That is also why there is no `authorize()` call here, and why that is not a
 * hole. `authorize` decides whether an actor may act on a *named* resource, and
 * there is none in scope: the answer this route returns is precisely the set of
 * organisations the caller holds an active membership in, which
 * `listOrganizationsForUser` establishes in SQL — the join to `org_members` with
 * `status = 'active'`, and the `deleted_at is null` filter, are the boundary.
 * Resolving each row back through `resolveOrg` to have something to authorise
 * would issue two more queries per organisation to reach the same set, in a
 * runtime that is allowed six outgoing connections in total.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  // A service token is pinned to one organisation, one project and one
  // environment by construction (threat T5). It has no membership rows and no
  // switcher, so the honest answer is a refusal rather than a list of one — an
  // empty or single-entry list would invite a client to treat this endpoint as
  // the place a CI credential discovers what else it can reach.
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Service tokens act in a single organisation.');
  }

  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;
  const memberships = await listOrganizationsForUser(services.db, userId);

  return json({
    organizations: memberships.map((membership) =>
      toOrganization(membership.organization, membership.role),
    ),
  });
});
