import { billingCounts, countWebhooks, freeOrganizationAllowance } from '@xecret/db/repositories';
import { billingConfigured } from '@/server/billing/config';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toEntitlementsPayload } from '@/server/schemas/entitlements';
import { authorize, resolveOrg } from '@/server/tenancy';

/**
 * `GET /api/orgs/{orgId}/entitlements`: what the plan allows, and how much of
 * each organisation-wide ceiling is used, so the dashboard can draw a control
 * the plan does not allow locked before anybody presses it. The payload, and
 * what it never carries, is described in `server/schemas/entitlements.ts`.
 *
 * ── Read once, never polled ──
 * The dashboard shell reads it once per organisation it is showing, and again
 * after a screen creates or deletes something it counts, when a locked control
 * is pressed, and on window focus at most once a minute. Nothing asks on a
 * timer: the database is on a plan where a request every few minutes from every
 * open tab would be the largest load the product puts on it. Three counts in
 * two round trips, the same counts the billing screen and the refusals read.
 *
 * ── Who may ──
 * Any member (`member.read`, which every role holds and no custom role can take
 * away), because every member sees the controls it locks. A service token is
 * refused: it is pinned to one environment and has no account whose allowance
 * this could describe. The answer decides which controls are drawn, never what
 * is permitted: every write past a ceiling is refused by the route that makes
 * it.
 */

/** The folder keeps its old name: the segment is the id, or a legacy slug (`resolveOrg`). */
type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Service tokens do not read an organisation’s plan.');
  }

  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.read');

  const orgId = scope.organization.id;
  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;
  const [counts, webhooks, allowance] = await Promise.all([
    billingCounts(services.db, orgId, new Date()),
    countWebhooks(services.db, orgId),
    freeOrganizationAllowance(services.db, userId),
  ]);

  return json({
    entitlements: toEntitlementsPayload({
      entitlements: scope.entitlements,
      seatLimit: scope.organization.seatLimit,
      counts,
      webhooks,
      allowance,
      upgrades: billingConfigured(services.env),
    }),
  });
});
