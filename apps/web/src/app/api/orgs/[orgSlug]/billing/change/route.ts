import { actorId } from '@/server/actor';
import { subscriptionResource } from '@/server/billing/effects';
import {
  authorizeBilling,
  previewPlanChange,
  requestPlanChange,
  requireBillingSession,
} from '@/server/billing/service';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { billingPreviewQuerySchema, billingSelectionSchema } from '@/server/schemas/billing';
import { resolveOrg } from '@/server/tenancy';

/**
 * Moving an existing subscription to another plan or billing period (P12).
 *
 *  - `GET ?plan=&interval=` — what the move would charge now, from Dodo's own
 *    proration preview, before the owner confirms. A downgrade charges nothing
 *    now and is answered without asking Dodo.
 *  - `POST { plan, interval }` — ask Dodo to make the move. Up (a higher plan,
 *    or monthly to yearly) takes effect at once and is prorated; down waits for
 *    the end of the period already paid for. A change whose charge fails is not
 *    applied.
 *
 * **Neither grants anything.** The plan changes when Dodo's
 * `subscription.plan_changed` arrives and the webhook applies it.
 *
 * Session-only, owners only (`billing.manage`); the move is rate limited like
 * a write and audited (`billing.plan_change_requested`).
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    requireBillingSession(principal);
    const scope = await resolveOrg(principal, params.orgSlug, services);
    authorizeBilling(scope, { audit: audit(scope.organization.id), record }, []);

    const selection = parseQuery(request, billingPreviewQuerySchema);
    const preview = await previewPlanChange(services, scope, selection);
    return json({
      preview: { effective: preview.effective, seats: preview.seats, charge: preview.charge },
    });
  },
);

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    requireBillingSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const orgAudit = audit(scope.organization.id);
    authorizeBilling(scope, { audit: orgAudit, record }, ['billing.plan_change_requested']);

    const selection = await parseJsonBody(request, billingSelectionSchema);
    const planned = await requestPlanChange(services, scope, selection);

    record(
      orgAudit.success(
        'billing.plan_change_requested',
        subscriptionResource(scope.organization.id),
        {
          plan: selection.plan,
          previousPlan: planned.previous.plan,
          billingInterval: selection.interval,
          ...(planned.previous.interval
            ? { previousBillingInterval: planned.previous.interval }
            : {}),
          seatCount: planned.seats,
          reason: planned.effective === 'now' ? 'takes effect now' : 'takes effect at renewal',
        },
      ),
    );
    return json({ requested: true, effective: planned.effective });
  },
);
