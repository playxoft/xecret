import type { AuditBuilder, AuditMetadata } from '@xecret/core/audit';
import type { Transaction } from '@xecret/db/repositories';
import {
  consumeCheckout,
  createFreeSubscription,
  lockSubscription,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import { catalogEntryFor } from '../config';
import type { BillingConfig } from '../config';
import { subscriptionResource } from '../audit';
import type { HandlerOutcome } from '../effects';
import type { DodoSubscription } from '../payloads';
import { decideSnapshot } from '../snapshot';
import { paymentFailedOccasion } from '../reminders';

/**
 * Every `subscription.*` event: apply the snapshot it carries.
 *
 * The decision is `decideSnapshot`'s; this writes it, under the row's lock,
 * with the audit record of what changed in the same transaction, and returns
 * what must happen once that transaction has committed — the emails and the
 * alerts. See `snapshot.ts` for the rules, and `webhook.ts` for the claim that
 * makes a delivery apply at most once.
 *
 * ── Attaching a new subscription spends its checkout ──
 * A subscription the row does not follow yet attaches only through the open
 * checkout it came from (`checkout`, found by the nonce in its metadata or the
 * session its payment named). Applying it spends that checkout in the same
 * transaction, so no second subscription — and no subscription an operator
 * later took the organisation off — can attach through it again.
 */
export async function applySubscriptionSnapshot(
  tx: Transaction,
  input: {
    orgId: string;
    eventType: string;
    eventAt: Date;
    now: Date;
    snapshot: DodoSubscription;
    config: BillingConfig;
    audit: AuditBuilder;
    /** The delivery's id; `null` when a job fetched the snapshot from Dodo itself. */
    webhookId: string | null;
    /** The open checkout this subscription came from, when placement found one. */
    checkout: { sessionId: string } | { nonce: string } | null;
  },
): Promise<HandlerOutcome> {
  const { orgId, eventType, snapshot, audit } = input;
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  const resource = subscriptionResource(orgId);

  let locked = await lockSubscription(tx, orgId);
  if (locked === null) {
    // Every organisation has a row by migration and by provisioning; one that
    // somehow does not gets the Free row it would have had.
    await createFreeSubscription(tx, orgId);
    locked = await lockSubscription(tx, orgId);
    if (locked === null) throw new Error('subscription row missing after insert');
  }
  const row = locked;

  const decision = decideSnapshot({
    row,
    snapshot,
    entry: catalogEntryFor(input.config, snapshot.product_id),
    eventAt: input.eventAt,
    now: input.now,
    samlAddonId: input.config.samlAddonId,
    mode: input.config.mode,
    webhookId: input.webhookId,
    attachable: input.checkout !== null,
  });

  const unverified = (): HandlerOutcome => {
    outcome.audit.push(
      audit.error('billing.duplicate_subscription', resource, 'conflict', {
        billingEvent: eventType,
        plan: row.plan,
      }),
    );
    outcome.effects.push({
      kind: 'alert',
      message:
        'A live Dodo subscription names this organisation but did not come from an open ' +
        'checkout of its own — it was not attached. Somebody may have bought through a link ' +
        'with our metadata typed in: refund or cancel it in Dodo',
      fields: { orgId, eventType },
    });
    return outcome;
  };

  if (decision.kind === 'ignore') {
    switch (decision.reason) {
      case 'duplicate-subscription':
      case 'operator-managed':
        outcome.audit.push(
          audit.error('billing.duplicate_subscription', resource, 'conflict', {
            billingEvent: eventType,
            plan: row.plan,
          }),
        );
        outcome.effects.push({
          kind: 'alert',
          message:
            decision.reason === 'operator-managed'
              ? 'A Dodo subscription event arrived for an organisation whose plan an operator set ' +
                'by hand — it was not applied. If the subscription is live, refund or cancel it ' +
                'in Dodo, or move the organisation onto it deliberately'
              : 'A second live Dodo subscription arrived for an organisation that already has one ' +
                '— it was not applied. The customer is paying twice: refund or cancel one in Dodo',
          fields: { orgId, eventType, reason: decision.reason },
        });
        break;
      case 'unverified-checkout':
        return unverified();
      case 'other-mode':
        outcome.effects.push({
          kind: 'alert',
          message:
            `A ${input.config.mode} Dodo event arrived for an organisation whose subscription ` +
            'was recorded in the other Dodo mode — it was not applied. Clear the old mode’s ' +
            'rows (docs/operations/billing.md, "Test mode") before taking payments in this one',
          fields: { orgId, eventType },
        });
        break;
      case 'unknown-product':
        outcome.audit.push(
          audit.error('billing.drift_detected', resource, 'invalidInput', {
            billingEvent: eventType,
            driftFields: ['product'],
          }),
        );
        outcome.effects.push({
          kind: 'alert',
          message:
            'A Dodo subscription is on a product this deployment does not sell — nothing was ' +
            'granted. Check the DODO_PRODUCT_* variables against the Dodo dashboard',
          fields: { orgId, eventType },
        });
        break;
      case 'pending':
      case 'stale':
      case 'other-subscription':
      case 'already-free':
      case 'not-reactivating':
        // Nothing to do, and nothing worth an alert: a reordered delivery or a
        // subscription that never mattered to this organisation's access.
        break;
    }
    return outcome;
  }

  // A subscription the row did not follow attaches by spending its checkout,
  // or not at all.
  if (row.dodoSubscriptionId !== snapshot.subscription_id) {
    const spent =
      input.checkout !== null &&
      (await consumeCheckout(tx, {
        orgId,
        subscriptionId: snapshot.subscription_id,
        by: input.checkout,
      }));
    if (!spent) return unverified();
  }

  await writeSubscriptionState(tx, orgId, decision.patch, decision.seats);

  const { change } = decision;
  if (change.material) {
    const metadata: AuditMetadata = {
      billingEvent: eventType,
      plan: change.plan,
      previousPlan: change.previousPlan,
      subscriptionStatus: change.status,
      previousSubscriptionStatus: change.previousStatus,
      seatCount: change.seats,
      previousSeatCount: change.previousSeats,
      ...(change.interval ? { billingInterval: change.interval } : {}),
      ...(change.previousInterval ? { previousBillingInterval: change.previousInterval } : {}),
      ...(decision.patch.currency ? { currency: decision.patch.currency } : {}),
      ...(decision.addonTurnedOn ? { addonName: 'saml' } : {}),
      ...(change.cancelAtPeriodEnd !== change.previousCancelAtPeriodEnd
        ? { reason: change.cancelAtPeriodEnd ? 'cancels at period end' : 'cancellation withdrawn' }
        : decision.ended
          ? { reason: 'subscription ended' }
          : {}),
    };
    outcome.audit.push(audit.success('plan.changed', resource, metadata));
  }

  if (decision.regionMismatch) {
    outcome.audit.push(
      audit.error('billing.region_mismatch', resource, 'conflict', { billingEvent: eventType }),
    );
    outcome.effects.push({
      kind: 'alert',
      message:
        'Dodo reports a billing country or currency other than the one this organisation is ' +
        'region-locked to — the locked values were kept. Check the subscription in Dodo',
      fields: { orgId, eventType },
    });
  }

  // A payment going wrong: the owners hear about it at once (and then at most
  // once a UTC day — see `paymentFailedOccasion`).
  const failing = (status: string) => status === 'past_due' || status === 'on_hold';
  if (failing(change.status) && !failing(change.previousStatus)) {
    outcome.effects.push({
      kind: 'mail',
      orgId,
      occasion: paymentFailedOccasion(input.now),
      reminder: { kind: 'payment_failed', plan: change.plan, firstPayment: false },
    });
  }

  // The checkout's quantity was counted when the owner clicked; people may have
  // joined or left before the payment landed. The seat sync pushes the count
  // as it is now, does nothing when it already matches, and is what tells the
  // owners when the bill moves.
  if (decision.activated) outcome.effects.push({ kind: 'seat-sync', orgId });

  if (decision.ended && row.addonSaml) {
    outcome.effects.push({
      kind: 'alert',
      message:
        'A subscription ended for an organisation that still holds the SAML add-on, which is ' +
        'never removed automatically. Decide whether to keep it, and remove its WorkOS ' +
        'connection if not (plan:set --addon saml --off)',
      fields: { orgId, eventType },
    });
  }

  return outcome;
}
