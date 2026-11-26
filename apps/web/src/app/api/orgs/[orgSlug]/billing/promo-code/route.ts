import { actorId } from '@/server/actor';
import { previewPromoCode } from '@/server/billing/promo-codes';
import { authorizeBilling, requireBillingSession } from '@/server/billing/service';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { promoCodeBodySchema } from '@/server/schemas/admin';
import { resolveOrg } from '@/server/tenancy';

/**
 * `POST /api/orgs/{orgSlug}/billing/promo-code` — what a code xecret issued
 * would do for this organisation, without doing it (migration 0035).
 *
 * The same checks as spending it — the code exists and is live, and is for
 * this person — so an owner is told at the field rather than at the button. A
 * code that does not exist, was revoked or is for somebody else gets one
 * answer. Rate limited like a write, per person: it is the one place a code
 * can be guessed at, and every guess costs a request from a signed-in owner.
 *
 * Owners only, in a browser session — the billing screen's own rules
 * (`server/billing/service.ts`).
 */

type Params = { orgSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const user = requireBillingSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal), 'promo-code']));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    authorizeBilling(scope, { audit: audit(scope.organization.id), record }, []);

    const { code } = await parseJsonBody(request, promoCodeBodySchema);
    return json({ promo: await previewPromoCode(services, user, code) });
  },
);
