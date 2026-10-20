import { actorId } from '@/server/actor';
import { subscriptionResource } from '@/server/billing/effects';
import { authorizeBilling, openPortal, requireBillingSession } from '@/server/billing/service';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { resolveOrg } from '@/server/tenancy';

/**
 * `POST /api/orgs/{orgSlug}/billing/portal` — a link into Dodo's customer
 * portal (P12): the card, the invoices, cancelling. We build none of that
 * ourselves — one less place a card number could go wrong.
 *
 * `POST`, though it changes nothing here, because what it hands out is a
 * session at Dodo for a few minutes: whoever opens it can change the card or
 * cancel the subscription. So it is minted only for an owner
 * (`billing.manage`), in an unlocked browser session, rate limited like a
 * write and audited every time (`billing.portal_opened`) — and the link itself
 * is never logged, stored or put in the audit record. `json()` marks the
 * response `no-store`.
 */

type Params = { orgSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    requireBillingSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgAudit = audit(scope.organization.id);
    authorizeBilling(scope, { audit: orgAudit, record }, ['billing.portal_opened']);

    const link = await openPortal(services, scope);
    record(orgAudit.success('billing.portal_opened', subscriptionResource(scope.organization.id)));
    return json({ link });
  },
);
