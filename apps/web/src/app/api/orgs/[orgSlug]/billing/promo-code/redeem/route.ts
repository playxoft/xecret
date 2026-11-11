import { actorId } from '@/server/actor';
import { redeemGrantCode } from '@/server/billing/promo-codes';
import { authorizeBilling, billingStatus, requireBillingSession } from '@/server/billing/service';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { promoCodeBodySchema } from '@/server/schemas/admin';
import { resolveOrg } from '@/server/tenancy';

/**
 * `POST /api/orgs/{orgSlug}/billing/promo-code/redeem` — spends a free-plan
 * code on this organisation (migration 0035): it moves to the code's plan now,
 * for the code's days or for good, with no card and nothing at Dodo.
 *
 * Only from Free, with no paid checkout on its way; once per organisation and
 * once per person; never past the code's limit — `redeemGrantCode`, which
 * counts the redemption and writes the plan in one transaction. A discount
 * code is refused here: it is applied at checkout.
 *
 * Audited as the `plan.changed` it is, by the owner who redeemed it, with the
 * code in the reason. Answers the billing screen as it now stands.
 *
 * Owners only (`billing.manage`), in a browser session.
 */

type Params = { orgSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const user = requireBillingSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal), 'promo-code']));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgAudit = audit(scope.organization.id);
    authorizeBilling(scope, { audit: orgAudit, record }, ['plan.changed']);

    const { code } = await parseJsonBody(request, promoCodeBodySchema);
    await redeemGrantCode(services, scope, user, code, orgAudit);

    // Resolved again: the scope above carries the entitlements of the plan
    // the organisation had, and the screen's warnings are read from them.
    const fresh = await resolveOrg(principal, params.orgSlug, services);
    return json({ billing: await billingStatus(services, fresh) });
  },
);
