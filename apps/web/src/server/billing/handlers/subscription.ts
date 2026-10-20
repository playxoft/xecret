import type { AuditBuilder, AuditMetadata } from '@xecret/core/audit';
import type { Transaction } from '@xecret/db/repositories';
import {
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

/**
 * Every `subscription.*` event: apply the snapshot it carries.
 *
 * The decision is `decideSnapshot`'s; this writes it, under the row's lock,
 * with the audit record of what changed in the same transaction, and returns
 * what must happen once that transaction has committed — the emails and the
 * alerts. See `snapshot.ts` for the rules, and `webhook.ts` for the claim that
 * makes a delivery apply at most once.
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
    webhookId: string;
  },
): Promise<HandlerOutcome> {
  const { orgId, eventType, snapshot, audit } = input;
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  const resource = subscriptionResource(orgId);

  let row = await lockSubscription(tx, orgId);
  if (row === null) {
    // Every organisation has a row by migration and by provisioning; one that
    // somehow does not gets the Free row it would have had.
    await createFreeSubscription(tx, orgId);
    row = await lockSubscription(tx, orgId);
    if (row === null) throw new Error('subscription row missing after insert');
  }

  const decision = decideSnapshot({
    row,
    snapshot,
    entry: catalogEntryFor(input.config, snapshot.product_id),
    eventAt: input.eventAt,
    now: input.now,
    samlAddonId: input.config.samlAddonId,
  });

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
              ? 'A live Dodo subscription arrived for an organisation whose plan an operator set ' +
                'by hand — it was not applied. Refund or cancel it in Dodo, or move the ' +
                'organisation onto it deliberately'
              : 'A second live Dodo subscription arrived for an organisation that already has one ' +
                '— it was not applied. The customer is paying twice: refund or cancel one in Dodo',
          fields: { orgId, eventType, reason: decision.reason },
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
        // Nothing to do, and nothing worth an alert: a reordered delivery or a
        // subscription that never mattered to this organisation's access.
        break;
    }
    return outcome;
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
  // daily — see `sendBillingReminder`).
  const failing = (status: string) => status === 'past_due' || status === 'on_hold';
  if (failing(change.status) && !failing(change.previousStatus)) {
    outcome.effects.push({
      kind: 'mail',
      orgId,
      occasion: `${snapshot.subscription_id}:${input.eventAt.toISOString().slice(0, 10)}`,
      reminder: { kind: 'payment_failed', plan: change.plan },
    });
  }

  // The seat count moved on a subscription that was already paid for: the
  // owners are told the new count and the new charge.
  if (
    !decision.activated &&
    !decision.ended &&
    change.seats !== change.previousSeats &&
    change.interval !== null
  ) {
    outcome.effects.push({
      kind: 'mail',
      orgId,
      occasion: input.webhookId,
      reminder: {
        kind: 'seats_changed',
        seats: change.seats,
        previousSeats: change.previousSeats,
        interval: change.interval,
        amountMinor: snapshot.recurring_pre_tax_amount,
        currency: snapshot.currency,
      },
    });
  }

  // The checkout's quantity was counted when the owner clicked; people may have
  // joined or left before the payment landed. The seat sync pushes the count
  // as it is now, and does nothing when it already matches.
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
