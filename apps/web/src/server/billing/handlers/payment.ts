import type { AuditBuilder } from '@xecret/core/audit';
import type { Transaction } from '@xecret/db/repositories';
import {
  findOrgIdByDodoSubscription,
  lockSubscription,
  recordLicenseKey,
  writeSubscriptionState,
} from '@xecret/db/repositories';
import { subscriptionResource } from '../audit';
import type { HandlerOutcome } from '../effects';
import type { DodoDispute, DodoLicenseKey, DodoPayment, DodoRefund } from '../payloads';

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
 * it. When the row follows no subscription yet — or is on Free — that payment
 * is what tells it which subscription id is now its own, so the
 * `subscription.active` beside it can be placed even if Dodo did not copy our
 * metadata onto the subscription. Linking grants nothing: the plan changes
 * only when the snapshot arrives.
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
    /** Whether the payment was traced to this organisation through our own checkout or metadata. */
    placedByCheckout: boolean;
    audit: AuditBuilder;
  },
): Promise<HandlerOutcome> {
  const { orgId, payment, audit } = input;
  const outcome: HandlerOutcome = { audit: [], effects: [] };
  const resource = subscriptionResource(orgId);
  const row = await lockSubscription(tx, orgId);
  if (row === null) return outcome;

  if (input.eventType === 'payment.failed') {
    outcome.audit.push(
      audit.success('billing.payment_failed', resource, {
        billingEvent: input.eventType,
        plan: row.plan,
      }),
    );
    outcome.effects.push({
      kind: 'mail',
      orgId,
      occasion: payment.payment_id,
      reminder: { kind: 'payment_failed', plan: row.plan },
    });
    return outcome;
  }

  // payment.succeeded
  const subscriptionId = payment.subscription_id ?? null;
  if (
    input.placedByCheckout &&
    subscriptionId !== null &&
    row.dodoSubscriptionId !== subscriptionId &&
    (row.dodoSubscriptionId === null || row.plan === 'free')
  ) {
    // Never steal a subscription another organisation already follows.
    const holder = await findOrgIdByDodoSubscription(tx, subscriptionId);
    if (holder === null) {
      await writeSubscriptionState(tx, orgId, {
        dodoSubscriptionId: subscriptionId,
        dodoCustomerId: payment.customer.customer_id,
        // The snapshot that follows is the first of this subscription's
        // history; nothing older than it can be stale yet.
        dodoEventAt: null,
      });
    } else if (holder !== orgId) {
      outcome.effects.push({
        kind: 'alert',
        message:
          'A payment from one organisation’s checkout names a subscription another ' +
          'organisation already follows — not linked. Check both in Dodo',
        fields: { orgId, otherOrgId: holder },
      });
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
