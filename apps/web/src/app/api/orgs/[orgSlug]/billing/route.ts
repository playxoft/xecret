import { billingStatus, authorizeBilling, requireBillingSession } from '@/server/billing/service';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { resolveOrg } from '@/server/tenancy';

/**
 * `GET /api/orgs/{orgSlug}/billing` — the billing screen (P12).
 *
 * The plan, the seats billed against the seats in use, the renewal, the
 * currency, this period's secret fetches against the allowance, the ceilings
 * the organisation is near, and which of checkout, plan change and the portal
 * will work from here. Read from our own rows only: the screen never waits on
 * Dodo, and a Dodo outage cannot take it down.
 *
 * Owners only (`billing.manage`), in a browser session — see
 * `server/billing/service.ts`. Answered whether or not this deployment takes
 * payments; `enabled` says which.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    requireBillingSession(principal);
    const scope = await resolveOrg(principal, params.orgSlug, services);
    authorizeBilling(scope, { audit: audit(scope.organization.id), record }, []);
    return json({ billing: await billingStatus(services, scope) });
  },
);
