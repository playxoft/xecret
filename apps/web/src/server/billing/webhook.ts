import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import * as z from 'zod/mini';
import {
  appendAuditEvents,
  claimWebhookEvent,
  countOrgsWithDodoCustomer,
  findCheckout,
  findCheckoutByNonce,
  findOpenCheckout,
  findOrgIdByDodoSubscription,
  findOrgIdByInvoicedPayment,
  liveOrganizationExists,
} from '@xecret/db/repositories';
import type { Executor } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { errors } from '../errors';
import { json, readRawBody } from '../http';
import { catalogEntryFor, billingSetup, CHECKOUT_OPEN_MS, isLicensedProduct } from './config';
import type { BillingConfig } from './config';
import { CHECKOUT_NONCE_METADATA_KEY, ORG_METADATA_KEY } from './client';
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
 *     the metadata our checkout put on it, which Dodo signs back to us: the
 *     organisation id **and the checkout's nonce**, which must match an open
 *     checkout of that organisation in `billing_checkouts`. Metadata alone is
 *     not enough — anybody can buy one of our products through a link with
 *     an organisation id typed into its metadata, and Dodo would sign that
 *     too. Such an event is claimed, attached to nothing, and raised. Never
 *     from anything a browser sent.
 *
 *     **Most of what arrives is not ours.** The Dodo account is shared with
 *     other products, and Dodo sends every endpoint every subscribed event
 *     type for all of them. An event that places to nothing of ours — another
 *     product's payment, subscription, refund, chargeback or licence key — is
 *     claimed and answered 200, and that is all: no row, no alert, no email, a
 *     debug line. A refund or a dispute is filed only by its payment; one
 *     whose customer alone is ours is raised unfiled (`place`). A licence key
 *     is ours by its product.
 *  5. **The claim**: `INSERT` into `billing_webhook_events`, whose primary key
 *     is `webhook-id`. A delivery already claimed answers 200 at once and
 *     changes nothing. This is a real unique constraint, not a SELECT before
 *     an INSERT: two concurrent deliveries of one event cannot both win.
 *  6. **The change**, in the same transaction as the claim — so a handler that
 *     throws rolls the claim back and Dodo's retry can succeed.
 *  7. **The effects** — emails, alerts — after the commit, off the response.
 *
 * ── Answers ──
 *  - 200: applied, or a duplicate, or an event this server does not act on —
 *    another product's included.
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

/** An open checkout of the organisation's, by what the event named it with. */
type CheckoutRef = { sessionId: string } | { nonce: string };

type Placement =
  | {
      orgId: string;
      /** The open checkout the event came from — `null` when placed by our stored subscription id or customer. */
      checkout: CheckoutRef | null;
      /** What that checkout was buying. */
      checkoutPlan: string | null;
    }
  /**
   * Not placed; `retry` when the event is ours and a later delivery could
   * place it; `foreign` when its metadata named one of our organisations
   * without a checkout of that organisation's to back it; `expired` when it
   * named that organisation's own checkout, unspent, past its window; `ours`
   * when it is ours, or may be, with no organisation to file it under — a
   * refund of our customer on a payment we never invoiced, a licence key for
   * a product we sell — and still acted on. Anything else unplaced is
   * somebody else's, and nothing is done with it.
   */
  | { orgId: null; retry: boolean; foreign?: boolean; expired?: boolean; ours?: boolean };

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

  const placement: Placement =
    prepared === 'unhandled'
      ? { orgId: null, retry: false }
      : await place(services.db, prepared, config, now);

  // An event for one of our subscriptions that cannot be placed *yet*: the
  // `subscription.active` of a checkout whose first payment — the event that
  // links the subscription to its organisation — has not arrived. Not claimed;
  // Dodo retries, and by then the payment has.
  if (placement.orgId === null && placement.retry) {
    if (placement.expired === true) {
      // Somebody paid through a checkout of ours after its week was up. Not a
      // stranger's purchase, so not claimed as one: Dodo keeps retrying while
      // a human looks (docs/operations/billing.md, "Stranded checkouts").
      log.error(
        `A ${eventType} came from one of our own checkouts, unspent but more than a week old — ` +
          'not attached yet; asking Dodo to retry. Attach it by hand if its payment does not ' +
          '(docs/operations/billing.md, "Stranded checkouts")',
        { webhookId, eventType },
      );
    } else {
      log.warn(`Could not yet place a ${eventType} webhook; asking Dodo to retry`, {
        webhookId,
        eventType,
      });
    }
    throw errors.unavailable('billing event not yet placeable');
  }

  // Ours to act on: placed, or ours with no organisation to file it under.
  // Anything else — but the `foreign` raise below — is another product's event
  // on the shared Dodo account, or a type this server does not act on.
  const ours = placement.orgId !== null || placement.ours === true;

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

    if (placement.orgId === null && placement.foreign === true) {
      outcome.effects.push({
        kind: 'alert',
        message:
          `A signed ${eventType} names one of our organisations in its metadata but carries no ` +
          'nonce of an open checkout of that organisation — attached to nothing. A purchase ' +
          'outside our checkout (a payment link with metadata typed in): refund or cancel it in Dodo',
        fields: { webhookId, eventType },
      });
    }

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
              checkout: placement.checkout,
            });
          }
          break;
        case 'payment':
          if (placement.orgId !== null && audit !== null) {
            outcome = await applyPaymentEvent(tx, {
              orgId: placement.orgId,
              eventType: prepared.type,
              payment: prepared.payment,
              checkout: placement.checkout,
              checkoutPlan: placement.checkoutPlan,
              mode: config.mode,
              now,
              audit,
            });
          }
          break;
        // Somebody else's refund, chargeback or licence key raises nothing and
        // keeps nothing: these act only on what `place` found to be ours.
        case 'refund':
          if (ours) outcome = refundOutcome(placement.orgId, prepared.refund, audit);
          break;
        case 'dispute':
          if (ours) outcome = disputeOutcome(placement.orgId, prepared.dispute, audit);
          break;
        case 'license':
          if (ours) outcome = await applyLicenseKey(tx, prepared.licence);
          break;
      }
    }

    if (outcome.audit.length > 0) await appendAuditEvents(tx, outcome.audit);
    return { duplicate: false as const, outcome };
  });

  if (!ours && placement.foreign !== true) {
    // Nothing was done, and nothing is said above debug: on a shared Dodo
    // account this is most of the traffic. The claim is the record of it.
    const what =
      prepared === 'unhandled'
        ? 'this server does not act on'
        : 'that places to nothing of ours — most likely another product’s on the shared Dodo account';
    log.debug(
      `Acknowledged a ${eventType} webhook ${what}${result.duplicate ? ', delivered again' : ''}`,
      { webhookId, eventType },
    );
    return json({ received: true });
  }

  if (result.duplicate) {
    log.info(`A ${eventType} webhook was delivered again; it was already handled`, {
      webhookId,
      eventType,
    });
    return json({ received: true });
  }

  log.info(`Handled a ${eventType} webhook`, {
    webhookId,
    eventType,
    orgId: placement.orgId,
  });

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
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The organisation our checkout's metadata names — only with the nonce of an
 * open checkout of that same organisation beside it. `foreign` when metadata
 * names a live organisation of ours without one: somebody else's purchase
 * wearing our organisation id. `expired` when the nonce is that
 * organisation's own, unspent, but older than the window: our own checkout,
 * paid late — never treated as foreign, and never attached by metadata
 * alone. It waits (503) for its payment to link it, or a human.
 */
type FromMetadata =
  | { kind: 'placed'; orgId: string; nonce: string; plan: string }
  /** Names a live organisation of ours, with no open checkout of its own behind it. */
  | { kind: 'foreign' }
  /** That organisation's own checkout, unspent, past the window. */
  | { kind: 'expired' }
  /** Names nothing of ours. */
  | { kind: 'none' };

async function fromMetadata(
  exec: Executor,
  metadata: Record<string, unknown> | null | undefined,
  now: Date,
): Promise<FromMetadata> {
  const value = metadata?.[ORG_METADATA_KEY];
  if (typeof value !== 'string' || !UUID.test(value)) return { kind: 'none' };
  const orgId = value.toLowerCase();
  if (!(await liveOrganizationExists(exec, orgId))) return { kind: 'none' };

  const nonce = metadata?.[CHECKOUT_NONCE_METADATA_KEY];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { kind: 'foreign' };
  const checkout = await findOpenCheckout(exec, {
    orgId,
    nonce,
    openSince: new Date(now.getTime() - CHECKOUT_OPEN_MS),
  });
  if (checkout !== null) return { kind: 'placed', orgId, nonce, plan: checkout.plan };
  const own = await findCheckoutByNonce(exec, { orgId, nonce });
  return own !== null && own.subscriptionId === null ? { kind: 'expired' } : { kind: 'foreign' };
}

async function place(
  exec: Executor,
  prepared: Prepared,
  config: BillingConfig,
  now: Date,
): Promise<Placement> {
  switch (prepared.family) {
    case 'subscription': {
      const { subscription } = prepared;
      const byId = await findOrgIdByDodoSubscription(exec, subscription.subscription_id);
      if (byId) return { orgId: byId, checkout: null, checkoutPlan: null };
      const byMetadata = await fromMetadata(exec, subscription.metadata, now);
      if (byMetadata.kind === 'placed') {
        return {
          orgId: byMetadata.orgId,
          checkout: { nonce: byMetadata.nonce },
          checkoutPlan: byMetadata.plan,
        };
      }
      if (byMetadata.kind === 'foreign') return { orgId: null, retry: false, foreign: true };
      // Our own checkout, paid after its window: not foreign, and not attached
      // by metadata alone — its payment links it by session, or a human does.
      if (byMetadata.kind === 'expired') return { orgId: null, retry: true, expired: true };
      // Not placed. Ours (a product we sell) is worth retrying for — its first
      // payment may yet link it; anything else — another product's
      // subscription on the shared Dodo account — never belonged to an
      // organisation and is claimed and left alone.
      return { orgId: null, retry: catalogEntryFor(config, subscription.product_id) !== null };
    }
    case 'payment': {
      const { payment } = prepared;
      if (payment.subscription_id) {
        const byId = await findOrgIdByDodoSubscription(exec, payment.subscription_id);
        if (byId) return { orgId: byId, checkout: null, checkoutPlan: null };
      }
      if (payment.checkout_session_id) {
        const checkout = await findCheckout(exec, payment.checkout_session_id);
        if (checkout && (await liveOrganizationExists(exec, checkout.orgId))) {
          return {
            orgId: checkout.orgId,
            checkout: { sessionId: checkout.sessionId },
            checkoutPlan: checkout.plan,
          };
        }
      }
      const byMetadata = await fromMetadata(exec, payment.metadata, now);
      if (byMetadata.kind === 'placed') {
        return {
          orgId: byMetadata.orgId,
          checkout: { nonce: byMetadata.nonce },
          checkoutPlan: byMetadata.plan,
        };
      }
      if (byMetadata.kind === 'expired') return { orgId: null, retry: true, expired: true };
      return { orgId: null, retry: false, foreign: byMetadata.kind === 'foreign' };
    }
    case 'refund':
    case 'dispute': {
      // Filed only by its payment — the one our invoice email named, under the
      // one organisation it named. An audit row in the wrong organisation is
      // one its owners can read, so nothing weaker files anything.
      const { customer, payment_id: paymentId } =
        prepared.family === 'refund' ? prepared.refund : prepared.dispute;
      const byPayment = await findOrgIdByInvoicedPayment(exec, paymentId);
      if (byPayment) return { orgId: byPayment, checkout: null, checkoutPlan: null };
      // A customer of ours on a payment we never invoiced is never filed: Dodo
      // reuses a customer per email across the account's products (ours make
      // one per organisation; theirs do not), so this may be another product's
      // refund. Raised with no organisation named, for a human to look at.
      // (A refund names its customer; Dodo's dispute names none.)
      const customerId = customer?.customer_id ?? null;
      if (customerId !== null && (await countOrgsWithDodoCustomer(exec, customerId)) > 0) {
        return { orgId: null, retry: false, ours: true };
      }
      // Neither: another product's refund or chargeback on the shared account —
      // or one of ours the invoice ledger missed (docs/operations/billing.md
      // §1, gap (a)), which Dodo, handling chargebacks as merchant of record,
      // still lists in its dashboard.
      return { orgId: null, retry: false };
    }
    case 'license':
      // A licence key belongs to no organisation; it is ours when its product
      // is — none is until P22 sells the self-host licences.
      return {
        orgId: null,
        retry: false,
        ours: isLicensedProduct(config, prepared.licence.product_id),
      };
  }
}
