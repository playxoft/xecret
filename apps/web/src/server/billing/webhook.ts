import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import * as z from 'zod/mini';
import {
  appendAuditEvents,
  claimWebhookEvent,
  findCheckout,
  findOrgIdByDodoCustomer,
  findOrgIdByDodoSubscription,
  liveOrganizationExists,
} from '@xecret/db/repositories';
import type { Executor } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import { json, readRawBody } from '../http';
import { catalogEntryFor, billingSetup } from './config';
import type { BillingConfig } from './config';
import { ORG_METADATA_KEY } from './client';
import { systemAudit } from './audit';
import { noOutcome, runBillingEffects } from './effects';
import type { HandlerOutcome } from './effects';
import {
  applyLicenseKey,
  applyPaymentEvent,
  disputeOutcome,
  refundOutcome,
} from './handlers/payment';
import { applySubscriptionSnapshot } from './handlers/subscription';
import {
  dodoDisputeSchema,
  dodoLicenseKeySchema,
  dodoPaymentSchema,
  dodoRefundSchema,
  dodoSubscriptionSchema,
  dodoWebhookEnvelopeSchema,
} from './payloads';

/**
 * `POST /api/billing/webhook` — Dodo telling us what happened. The sharp edge.
 *
 * ── The sequence, and why each step is where it is ──
 *
 *  1. **The raw body**, bounded, before anything else. The signature is over
 *     bytes, so nothing may parse and re-serialise them first.
 *  2. **The signature** — Standard Webhooks, HMAC-SHA256 over
 *     `${webhook-id}.${webhook-timestamp}.${body}` with `DODO_WEBHOOK_SECRET`
 *     — verified by the `standardwebhooks` library: the code Dodo's own SDK
 *     `unwrap()` runs, not a hand-rolled HMAC. Its comparison is constant-time
 *     and it accepts the space-separated list of signatures a secret rotation
 *     sends.
 *  3. **The replay window**: a timestamp more than five minutes old, or in the
 *     future, is refused by the same verification. A captured delivery cannot
 *     be replayed later; a replay inside the window is stopped by step 5.
 *  4. **Where it goes**: the organisation, from our own records — the
 *     subscription id we stored, the checkout session we created — or from
 *     the organisation id we put in the metadata, which Dodo signs back to us.
 *     Never from anything a browser sent.
 *  5. **The claim**: `INSERT` into `billing_webhook_events`, whose primary key
 *     is `webhook-id`. A delivery already claimed answers 200 at once and
 *     changes nothing. This is a real unique constraint, not a SELECT before
 *     an INSERT: two concurrent deliveries of one event cannot both win.
 *  6. **The change**, in the same transaction as the claim — so a handler that
 *     throws rolls the claim back and Dodo's retry can succeed.
 *  7. **The effects** — emails, alerts — after the commit, off the response.
 *
 * ── Answers ──
 *  - 200: applied, or a duplicate, or an event this server does not act on.
 *  - 401: not from Dodo, or too old. Nothing is read, written or claimed.
 *  - 400: from Dodo, but not a shape we understand. Logged; not claimed.
 *  - 503: billing is off or half-configured, or the event is ours but cannot
 *    be placed yet (a `subscription.active` racing its own first payment).
 *    Not claimed, so Dodo's retries — eight of them, over a day — try again.
 *
 * Unknown event types are claimed and answered 200, never 500: a type Dodo
 * adds tomorrow must not put this endpoint into a retry storm.
 */

/** The largest body accepted. Dodo's payloads are a few kilobytes. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** `webhook-id` as Standard Webhooks shapes it (`msg_…`), bounded before it reaches a primary key. */
const WEBHOOK_ID = /^[A-Za-z0-9_.:-]{1,255}$/;

type Placement =
  | { orgId: string; placedByCheckout: boolean }
  /** Not placed; `retry` when the event is ours and a later delivery could place it. */
  | { orgId: null; retry: boolean };

export async function receiveDodoWebhook(
  services: ServiceContext,
  request: Request,
): Promise<Response> {
  const log = services.log.at('billingWebhook');

  // Billing off, or half-configured (which throws a 503 of its own). Answered
  // before the body is read: there is nothing here to verify against.
  const setup = billingSetup(services.env);
  if (setup.state === 'disabled') {
    log.warn('A billing webhook arrived on a deployment with payments switched off');
    throw errors.unavailable('billing is not configured');
  }
  const { config } = setup;

  const webhookId = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signature = request.headers.get('webhook-signature');
  if (!webhookId || !timestamp || !signature || !WEBHOOK_ID.test(webhookId)) {
    log.warn('Refused a billing webhook without valid Standard Webhooks headers');
    throw errors.unauthenticated('webhook headers');
  }

  const raw = await readRawBody(request, MAX_WEBHOOK_BODY_BYTES);

  try {
    new Webhook(config.webhookSecret).verify(raw, {
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    });
  } catch (cause) {
    // The reason is the library's own sentence — "No matching signature
    // found", "Message timestamp too old" — which carries no secret and no
    // payload. A burst of these is somebody probing the endpoint.
    log.warn('Refused a billing webhook that did not verify', {
      reason: cause instanceof WebhookVerificationError ? cause.message : 'verification failed',
    });
    throw errors.unauthenticated('webhook signature');
  }

  let envelope: z.infer<typeof dodoWebhookEnvelopeSchema>;
  try {
    const parsed = dodoWebhookEnvelopeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('envelope');
    envelope = parsed.data;
  } catch {
    log.error('A verified billing webhook was not a shape this server understands', {
      webhookId,
    });
    throw errors.badRequest('Unrecognised webhook payload.');
  }

  const eventType = envelope.type;
  const eventAt = new Date(envelope.timestamp);
  if (Number.isNaN(eventAt.getTime())) throw errors.badRequest('Unrecognised webhook timestamp.');
  const now = new Date();

  const prepared = prepare(eventType, envelope.data);
  if (prepared === 'malformed') {
    log.error(`A verified ${eventType} webhook carried data this server cannot read`, {
      webhookId,
      eventType,
    });
    throw errors.badRequest('Unrecognised webhook payload.');
  }

  const placement =
    prepared === 'unhandled'
      ? { orgId: null, retry: false }
      : await place(services.db, prepared, config);

  // An event for one of our subscriptions that cannot be placed *yet*: the
  // `subscription.active` of a checkout whose first payment — the event that
  // links the subscription to its organisation — has not arrived. Not claimed;
  // Dodo retries, and by then the payment has.
  if (placement.orgId === null && placement.retry) {
    log.warn(`Could not yet place a ${eventType} webhook; asking Dodo to retry`, {
      webhookId,
      eventType,
    });
    throw errors.unavailable('billing event not yet placeable');
  }

  const result = await services.db.transaction(async (tx) => {
    const claimed = await claimWebhookEvent(tx, {
      webhookId,
      eventType,
      occurredAt: eventAt,
      orgId: placement.orgId,
    });
    if (!claimed) return { duplicate: true as const, outcome: noOutcome() };

    const audit =
      placement.orgId === null ? null : systemAudit(services, placement.orgId, 'Dodo webhook');
    let outcome: HandlerOutcome = noOutcome();

    if (prepared !== 'unhandled') {
      switch (prepared.family) {
        case 'subscription':
          if (placement.orgId !== null && audit !== null) {
            outcome = await applySubscriptionSnapshot(tx, {
              orgId: placement.orgId,
              eventType,
              eventAt,
              now,
              snapshot: prepared.subscription,
              config,
              audit,
              webhookId,
            });
          }
          break;
        case 'payment':
          if (placement.orgId !== null && audit !== null) {
            outcome = await applyPaymentEvent(tx, {
              orgId: placement.orgId,
              eventType: prepared.type,
              payment: prepared.payment,
              placedByCheckout: placement.placedByCheckout,
              audit,
            });
          }
          break;
        case 'refund':
          outcome = refundOutcome(placement.orgId, prepared.refund, audit);
          break;
        case 'dispute':
          outcome = disputeOutcome(placement.orgId, prepared.dispute, audit);
          break;
        case 'license':
          outcome = await applyLicenseKey(tx, prepared.licence);
          break;
      }
    }

    if (outcome.audit.length > 0) await appendAuditEvents(tx, outcome.audit);
    return { duplicate: false as const, outcome };
  });

  if (result.duplicate) {
    log.info(`A ${eventType} webhook was delivered again; it was already handled`, {
      webhookId,
      eventType,
    });
    return json({ received: true });
  }

  if (prepared === 'unhandled') {
    log.info(`Received a ${eventType} webhook this server does not act on`, {
      webhookId,
      eventType,
    });
  } else {
    log.info(`Handled a ${eventType} webhook`, {
      webhookId,
      eventType,
      orgId: placement.orgId,
    });
  }

  if (result.outcome.effects.length > 0) {
    services.waitUntil(runBillingEffects(services, result.outcome.effects));
  }
  return json({ received: true });
}

/* ── preparation: which handler, with which parsed data ──────────────────── */

type Prepared =
  | {
      family: 'subscription';
      subscription: z.infer<typeof dodoSubscriptionSchema>;
    }
  | {
      family: 'payment';
      type: 'payment.succeeded' | 'payment.failed';
      payment: z.infer<typeof dodoPaymentSchema>;
    }
  | { family: 'refund'; refund: z.infer<typeof dodoRefundSchema> }
  | { family: 'dispute'; dispute: z.infer<typeof dodoDisputeSchema> }
  | { family: 'license'; licence: z.infer<typeof dodoLicenseKeySchema> };

/**
 * The twelve subscribed events (`.local/dodo/dodo-setup.md` Part 9) and the
 * other `subscription.*` events — every one carries the whole subscription and
 * is applied as a snapshot. Anything else is `'unhandled'`: claimed, logged,
 * answered 200.
 */
function prepare(type: string, data: unknown): Prepared | 'unhandled' | 'malformed' {
  if (type.startsWith('subscription.')) {
    const parsed = dodoSubscriptionSchema.safeParse(data);
    if (!parsed.success) return 'malformed';
    return { family: 'subscription', subscription: parsed.data };
  }
  switch (type) {
    case 'payment.succeeded':
    case 'payment.failed': {
      const parsed = dodoPaymentSchema.safeParse(data);
      if (!parsed.success) return 'malformed';
      return { family: 'payment', type, payment: parsed.data };
    }
    case 'refund.succeeded': {
      const parsed = dodoRefundSchema.safeParse(data);
      if (!parsed.success) return 'malformed';
      return { family: 'refund', refund: parsed.data };
    }
    case 'dispute.opened': {
      const parsed = dodoDisputeSchema.safeParse(data);
      if (!parsed.success) return 'malformed';
      return { family: 'dispute', dispute: parsed.data };
    }
    case 'license_key.created': {
      const parsed = dodoLicenseKeySchema.safeParse(data);
      if (!parsed.success) return 'malformed';
      return { family: 'license', licence: parsed.data };
    }
    default:
      return 'unhandled';
  }
}

/* ── placement: which organisation, from our own records ─────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The organisation id we put in the metadata, if it names a live organisation. */
async function fromMetadata(
  exec: Executor,
  metadata: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  const value = metadata?.[ORG_METADATA_KEY];
  if (typeof value !== 'string' || !UUID.test(value)) return null;
  return (await liveOrganizationExists(exec, value)) ? value.toLowerCase() : null;
}

async function place(
  exec: Executor,
  prepared: Prepared,
  config: BillingConfig,
): Promise<Placement> {
  switch (prepared.family) {
    case 'subscription': {
      const { subscription } = prepared;
      const byId = await findOrgIdByDodoSubscription(exec, subscription.subscription_id);
      if (byId) return { orgId: byId, placedByCheckout: false };
      const byMetadata = await fromMetadata(exec, subscription.metadata);
      if (byMetadata) return { orgId: byMetadata, placedByCheckout: true };
      // Not placed. Ours (a product we sell) is worth retrying for; anything
      // else — a self-host licence subscription — never belonged to an
      // organisation and is claimed and left alone.
      return { orgId: null, retry: catalogEntryFor(config, subscription.product_id) !== null };
    }
    case 'payment': {
      const { payment } = prepared;
      if (payment.subscription_id) {
        const byId = await findOrgIdByDodoSubscription(exec, payment.subscription_id);
        if (byId) return { orgId: byId, placedByCheckout: false };
      }
      if (payment.checkout_session_id) {
        const checkout = await findCheckout(exec, payment.checkout_session_id);
        if (checkout && (await liveOrganizationExists(exec, checkout.orgId))) {
          return { orgId: checkout.orgId, placedByCheckout: true };
        }
      }
      const byMetadata = await fromMetadata(exec, payment.metadata);
      if (byMetadata) return { orgId: byMetadata, placedByCheckout: true };
      return { orgId: null, retry: false };
    }
    case 'refund':
    case 'dispute':
    case 'license':
      // Placed only when exactly one organisation holds the customer — a
      // refund or a dispute is an alert either way, and a guess would file it
      // in somebody else's audit log.
      if (prepared.family === 'refund' && prepared.refund.customer) {
        const orgId = await findOrgIdByDodoCustomer(exec, prepared.refund.customer.customer_id);
        if (orgId) return { orgId, placedByCheckout: false };
      }
      return { orgId: null, retry: false };
  }
}
