import type { AuditBuilder } from '@xecret/core/audit';
import type { Transaction } from '@xecret/db/repositories';
import {
  consumeCheckout,
  findOrgIdByDodoSubscription,
  lockSubscription,
  recordLicenseKey,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import { subscriptionResource } from '../audit';
import type { DodoMode } from '../config';
import type { HandlerOutcome } from '../effects';
import type { DodoDispute, DodoLicenseKey, DodoPayment, DodoRefund } from '../payloads';
import { paymentFailedOccasion } from '../reminders';

/**
 * Payments, refunds, disputes and licence keys.
 *
 * None of these changes what an organisation may do. A payment's effect on
 * access arrives as the subscription snapshot beside it; a refund or a dispute
 * is somebody's decision about money and is never a reason to lock anybody
 * out — "a dispute is not a signal to lock someone out" (01-billing §P12).
 * What these do is record, alert, and — for the first payment of a checkout —
 * tell the row which subscription it now follows.
 */

/**
 * `payment.succeeded` / `payment.failed`.
 *
 * ── Linking a first checkout ──
 * The payment of a checkout this server created carries the checkout's
 * session id, which `billing_checkouts` maps to the organisation that started
 * it (or the checkout's nonce, in its metadata). When the row is **on Free**,
 * that payment is what tells it which subscription id is now its own, so the
 * `subscription.active` beside it can be placed even if Dodo did not copy our
 * metadata onto the subscription. Linking spends the checkout and grants
 * nothing: the plan changes only when the snapshot arrives.
 *
 * Never on a paid row. One on a paid plan with no subscription is an
 * operator's grant — an Enterprise contract, a hand-made trial — and a payment
 * linking a subscription to it would hand the next snapshot of that
 * subscription the contract to overwrite. It is reported instead.
 *
 * ── The purchasing-power guardrail ──
 * Billing country and card-issuing country disagreeing (pricing-plan §4) is
 * raised for a human and changes nothing: a traveller and an arbitrageur look
 * the same from here, and the card country is a card detail that is compared
 * and dropped — it is never stored or logged.
 */
export async function applyPaymentEvent(
  tx: Transaction,
  input: {
    orgId: string;
    eventType: 'payment.succeeded' | 'payment.failed';
    payment: DodoPayment;
    /** The open checkout of this organisation's the payment came from, when placement found one. */
    checkout: { sessionId: string } | { nonce: string } | null;
    /** The plan that checkout was for, when known — what a failed first payment was buying. */
    checkoutPlan: string | null;
    mode: DodoMode;
    now: Date;
    audit: AuditBuilder;
  },
): Promise<HandlerOutcome> {
  const { orgId, payment, audit } = input;
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  const resource = subscriptionResource(orgId);
  const row = await lockSubscription(tx, orgId);
  if (row === null) return outcome;

  if (row.dodoMode !== null && row.dodoMode !== input.mode) {
    outcome.effects.push({
      kind: 'alert',
      message:
        `A ${input.mode} Dodo payment arrived for an organisation whose subscription was ` +
        'recorded in the other Dodo mode — nothing was linked or sent. Clear the old mode’s ' +
        'rows (docs/operations/billing.md, "Test mode")',
      fields: { orgId, eventType: input.eventType },
    });
    return outcome;
  }

  if (input.eventType === 'payment.failed') {
    // The first payment of a checkout, on an organisation that holds no plan
    // from it: nothing was bought, and there is no subscription to speak of.
    const firstPayment = row.plan === 'free';
    const plan = firstPayment ? (input.checkoutPlan ?? row.plan) : row.plan;
    outcome.audit.push(
      audit.success('billing.payment_failed', resource, {
        billingEvent: input.eventType,
        plan: row.plan,
      }),
    );
    outcome.effects.push({
      kind: 'mail',
      orgId,
      occasion: paymentFailedOccasion(input.now),
      reminder: { kind: 'payment_failed', plan, firstPayment },
    });
    return outcome;
  }

  // payment.succeeded
  const subscriptionId = payment.subscription_id ?? null;
  if (
    input.checkout !== null &&
    subscriptionId !== null &&
    row.dodoSubscriptionId !== subscriptionId
  ) {
    if (row.plan !== 'free') {
      // An operator's grant, or a second subscription beside the one the row
      // follows: nothing is linked, and a human decides.
      outcome.effects.push({
        kind: 'alert',
        message:
          row.dodoSubscriptionId === null
            ? 'A checkout payment arrived for an organisation whose plan an operator set by hand ' +
              '— its subscription was not linked, and will not be applied. Refund or cancel it ' +
              'in Dodo, or move the organisation onto it deliberately'
            : 'A checkout payment arrived for an organisation that already follows another ' +
              'subscription — not linked. The customer may be paying twice: check both in Dodo',
        fields: {
          orgId,
          reason: row.dodoSubscriptionId === null ? 'operator-managed' : 'duplicate',
        },
      });
    } else if (row.dodoSubscriptionId !== null && row.dodoEventAt === null) {
      // A Free row still waiting for the subscription an earlier checkout's
      // payment linked: two checkouts paid before either activated. The
      // first link stands — replacing it would strand a subscription the
      // customer has already paid for — and a human refunds one.
      outcome.effects.push({
        kind: 'alert',
        message:
          'A checkout payment arrived for an organisation still waiting for the subscription ' +
          'another checkout’s payment linked — not linked. The customer is paying twice: refund ' +
          'or cancel one in Dodo',
        fields: { orgId, reason: 'duplicate' },
      });
    } else {
      // Never steal a subscription another organisation already follows.
      const holder = await findOrgIdByDodoSubscription(tx, subscriptionId);
      if (holder !== null && holder !== orgId) {
        outcome.effects.push({
          kind: 'alert',
          message:
            'A payment from one organisation’s checkout names a subscription another ' +
            'organisation already follows — not linked. Check both in Dodo',
          fields: { orgId, otherOrgId: holder },
        });
      } else if (holder === null) {
        const spent = await consumeCheckout(tx, { orgId, subscriptionId, by: input.checkout });
        if (spent) {
          await writeSubscriptionState(tx, orgId, {
            dodoSubscriptionId: subscriptionId,
            dodoCustomerId: payment.customer.customer_id,
            dodoMode: input.mode,
            // The snapshot that follows is the first of this subscription's
            // history; nothing older than it can be stale yet.
            dodoEventAt: null,
            dodoEventId: null,
          });
        } else {
          outcome.effects.push({
            kind: 'alert',
            message:
              'A checkout payment arrived whose checkout was already spent on another ' +
              'subscription — not linked. The customer may be paying twice: check Dodo',
            fields: { orgId },
          });
        }
      }
    }
  }

  const cardCountry = payment.card_issuing_country ?? null;
  if (cardCountry !== null && cardCountry !== payment.billing.country) {
    outcome.audit.push(
      audit.error('billing.region_mismatch', resource, 'conflict', {
        billingEvent: input.eventType,
      }),
    );
    outcome.effects.push({
      kind: 'alert',
      message:
        'A payment’s billing country is not the country that issued its card (the PPP ' +
        'guardrail, pricing-plan §4). Nothing was changed — review the customer in Dodo',
      fields: { orgId },
    });
  }

  outcome.effects.push({
    kind: 'mail',
    orgId,
    occasion: payment.payment_id,
    reminder: { kind: 'invoice_available' },
  });
  return outcome;
}

/** `refund.succeeded`: recorded, and a human told. Access is untouched. */
export function refundOutcome(
  orgId: string | null,
  refund: DodoRefund,
  audit: AuditBuilder | null,
): HandlerOutcome {
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  if (orgId !== null && audit !== null) {
    outcome.audit.push(
      audit.success('billing.refunded', subscriptionResource(orgId), {
        billingEvent: 'refund.succeeded',
        reason: refund.is_partial ? 'partial refund' : 'full refund',
      }),
    );
  }
  outcome.effects.push({
    kind: 'alert',
    message:
      'Dodo refunded a payment. Access is unchanged — if the refund ends the customer’s ' +
      'subscription, Dodo’s subscription event will say so',
    fields: { orgId, refundId: refund.refund_id, paymentId: refund.payment_id },
  });
  return outcome;
}

/** `dispute.opened`: recorded, and a human told. Never a reason to lock anybody out. */
export function disputeOutcome(
  orgId: string | null,
  dispute: DodoDispute,
  audit: AuditBuilder | null,
): HandlerOutcome {
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  if (orgId !== null && audit !== null) {
    outcome.audit.push(
      audit.success('billing.dispute_opened', subscriptionResource(orgId), {
        billingEvent: 'dispute.opened',
      }),
    );
  }
  outcome.effects.push({
    kind: 'alert',
    message:
      'A cardholder opened a dispute (chargeback). Respond in the Dodo dashboard; access is ' +
      'deliberately unchanged',
    fields: { orgId, disputeId: dispute.dispute_id, paymentId: dispute.payment_id },
  });
  return outcome;
}

/**
 * `license_key.created`: a self-host licence was issued. Stored against its
 * order — product, payment, subscription, activations, expiry — and **never
 * the key itself**, which Dodo emails to the buyer and `dodoLicenseKeySchema`
 * drops before this sees it.
 */
export async function applyLicenseKey(
  tx: Transaction,
  licence: DodoLicenseKey,
): Promise<HandlerOutcome> {
  const parse = (value: string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  await recordLicenseKey(tx, {
    licenseKeyId: licence.id,
    productId: licence.product_id,
    dodoCustomerId: licence.customer_id ?? null,
    dodoSubscriptionId: licence.subscription_id ?? null,
    dodoPaymentId: licence.payment_id ?? null,
    activationsLimit: licence.activations_limit ?? null,
    expiresAt: parse(licence.expires_at),
    issuedAt: parse(licence.created_at),
  });
  return { audit: [], effects: [] };
}
