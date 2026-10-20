import { actorId } from '@/server/actor';
import { subscriptionResource } from '@/server/billing/audit';
import { authorizeBilling, requireBillingSession, startCheckout } from '@/server/billing/service';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { billingSelectionSchema } from '@/server/schemas/billing';
import { resolveOrg } from '@/server/tenancy';

/**
 * `POST /api/orgs/{orgSlug}/billing/checkout` — send an owner to Dodo's hosted
 * checkout for a plan (P12).
 *
 * The body names a plan and a billing period and nothing else. The seats are
 * counted from the membership, the currency follows the billing country Dodo
 * records (pinned while the region lock holds), and the price is the Dodo
 * product's. We never see the card.
 *
 * **The return from checkout grants nothing.** Dodo sends the browser back to
 * the billing screen with `?checkout=returned`, and the screen waits for the
 * plan to change — which only the signed webhook does.
 *
 * Session-only (a bearer token may not start a purchase), owners only
 * (`billing.manage`), rate limited like a write, and audited
 * (`billing.checkout_started`). Refused for an organisation that already has a
 * subscription — a second one would charge twice — and for one whose plan
 * support set by hand.
 */

type Params = { orgSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const user = requireBillingSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgAudit = audit(scope.organization.id);
    authorizeBilling(scope, { audit: orgAudit, record }, ['billing.checkout_started']);

    const selection = await parseJsonBody(request, billingSelectionSchema);
    const { url, seats } = await startCheckout(services, scope, user, selection);

    record(
      orgAudit.success('billing.checkout_started', subscriptionResource(scope.organization.id), {
        plan: selection.plan,
        billingInterval: selection.interval,
        seatCount: seats,
      }),
    );
    return json({ url });
  },
);
