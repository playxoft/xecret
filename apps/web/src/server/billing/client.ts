import type * as z from 'zod/mini';
import { scrubText } from '../logging';
import type { BillingConfig } from './config';
import {
  dodoCheckoutSessionSchema,
  dodoPaymentMethodsSchema,
  dodoPlanPreviewSchema,
  dodoPortalSessionSchema,
  dodoSubscriptionSchema,
} from './payloads';
import type { DodoSubscription } from './payloads';

/**
 * Dodo, at the one boundary where this server talks to it.
 *
 * ── Plain `fetch`, not the `dodopayments` SDK ──
 * The SDK is a generated client over the same REST API, and this server needs
 * six of its calls. Plain fetch against the documented endpoints keeps the
 * Worker bundle free of a dependency tree nobody reviewed for workerd, keeps
 * every byte that leaves for Dodo in this one file, and makes the test stub the
 * same shape as production. Webhook verification is the exception, and uses
 * the very library the SDK's `unwrap()` delegates to — see `webhook.ts`.
 *
 * ── What leaves ──
 * The API key, in the `Authorization` header and nowhere else. The owner's
 * email address and name at checkout, because Dodo is the merchant of record
 * and an invoice needs a buyer. Our organisation id and the checkout's random
 * nonce, as metadata, so a webhook can be traced back to a checkout this server
 * created. No member list, no secret, nothing from a vault.
 *
 * ── What is never logged ──
 * A response body. Dodo's objects carry customer names, addresses and card
 * details; an error from Dodo is reduced to its status and a short error code,
 * scrubbed, before anything else sees it ({@link DodoApiError}).
 *
 * ── The data path never calls this ──
 * D15: Dodo is the billing truth, `org_subscriptions` the access truth. A
 * secret fetch must never wait on a third party, so nothing on the fetch path
 * imports this module.
 */

/** How long a call to Dodo may take before it is abandoned. Webhooks get 15 s; we take less. */
export const DODO_TIMEOUT_MS = 10_000;

/** What went wrong with a call, as a category a log line and an audit reason can carry. */
export type DodoFailure =
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'timeout'
  | 'network'
  | 'malformed';

/**
 * A call to Dodo that did not succeed.
 *
 * Carries the HTTP status and a category, and at most a short code from Dodo's
 * error body — never the body. `detail` is scrubbed of anything address- or
 * customer-shaped and bounded, because a provider that rejects a request often
 * quotes it back.
 */
export class DodoApiError extends Error {
  constructor(
    readonly category: DodoFailure,
    readonly status: number | null,
    readonly detail: string | null = null,
  ) {
    super(`Dodo call failed: ${category}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'DodoApiError';
  }

  /** Whether trying again later could succeed. A refusal of the request itself cannot. */
  get retryable(): boolean {
    return (
      this.category === 'rate_limited' ||
      this.category === 'upstream_5xx' ||
      this.category === 'timeout' ||
      this.category === 'network'
    );
  }
}

/** One overage event: a thousand secret fetches past the plan's allowance. */
export interface UsageEvent {
  /** Deterministic — `${orgId}:${periodStart}:${unitIndex}` — so a retry cannot bill twice. */
  eventId: string;
  customerId: string;
  eventName: string;
  timestamp: Date;
}

export interface CheckoutRequest {
  productId: string;
  quantity: number;
  /**
   * The customer Dodo already has **for this organisation**, or the buyer by
   * email — in which case Dodo is told to create a new customer however many
   * it already has for that address (`always_create_new_customer`). Without
   * that, Dodo reuses the customer an email already has, so one person owning
   * two organisations would make them one customer: one customer portal, with
   * both organisations' invoices and cards in it, opened from either.
   */
  customer: { customerId: string } | { email: string; name: string | null };
  returnUrl: string;
  /** Our organisation id. Dodo signs it back to us in every webhook. */
  orgId: string;
  /**
   * The random nonce recorded with this checkout (`billing_checkouts.nonce`).
   * Dodo copies checkout metadata onto the payment and the subscription it
   * produces, and a subscription is attached to an organisation by metadata
   * only when it carries the nonce of an open checkout of that organisation.
   */
  nonce: string;
  /**
   * The purchasing-power region lock: while it holds, checkout is pinned to the
   * country and currency the organisation was first billed in, and the buyer
   * cannot edit the country. `null` lets Dodo price by the billing country the
   * buyer enters — never by a currency the browser asked for.
   */
  regionLock: { country: string; currency: string } | null;
}

export interface PlanChange {
  productId: string;
  quantity: number;
  /**
   * How Dodo bills the change, as its docs define the modes
   * (https://docs.dodopayments.com/developer-resources/subscription-upgrade-downgrade):
   *
   *  - `prorated_immediately_keep_cycle` for seat changes: "charges the price
   *    difference between the new and old plan for the time left in the
   *    current cycle", quantity included, and "keeps `next_billing_date`". A
   *    seat removed leaves a negative difference, which this mode puts in the
   *    **Dodo customer's wallet** — one customer per organisation — where Dodo
   *    applies it to the next charges; it is never refunded to the card.
   *  - `prorated_immediately` for an upgrade: credits the unused part of the
   *    current cycle — credit scoped to the subscription, applied to its
   *    renewals — and charges a full cycle of the new plan, the cycle
   *    restarting that day. During a trial it ends the trial and charges at
   *    once (`decideSnapshot` reads the trial as over from that payment).
   *
   * Not `difference_immediately`, which the seat sync used first: it charges
   * the whole price difference and **resets the billing cycle to the day of
   * the change** — every member added would have restarted the subscription's
   * period (and moved its renewal date), which is not what the pricing page
   * or the seat email describes.
   */
  proration: 'prorated_immediately_keep_cycle' | 'prorated_immediately';
  /** A downgrade waits for the period the customer already paid for. */
  effectiveAt: 'immediately' | 'next_billing_date';
  /**
   * What happens to the change when its charge fails.
   *
   * `prevent_change` for a plan change: a plan the card did not pay for is
   * never granted. `apply_change` for a seat change: the person has already
   * joined, so the subscription should say so, and an unpaid difference is a
   * dunning matter (the subscription goes on hold, the owners are emailed) —
   * not a reason for the bill to disagree with the membership.
   */
  onPaymentFailure: 'prevent_change' | 'apply_change';
}

/** What a plan change would charge now, in the subscription's currency. */
export interface PlanChangePreview {
  currency: string;
  /** In the currency's smallest unit; negative is a credit. */
  amountMinor: number;
}

/** The slice of Dodo this server depends on. Tests hand in a stub of exactly this. */
export interface BillingProvider {
  createCheckoutSession(request: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  changePlan(subscriptionId: string, change: PlanChange): Promise<void>;
  previewPlanChange(subscriptionId: string, change: PlanChange): Promise<PlanChangePreview>;
  getSubscription(subscriptionId: string): Promise<DodoSubscription>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ link: string }>;
  ingestUsage(events: readonly UsageEvent[]): Promise<void>;
  /** The expiry of the customer's saved cards, keyed by payment method id. */
  cardExpiries(customerId: string): Promise<Map<string, { month: number; year: number }>>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Dodo's metadata keys for our organisation id and the checkout's nonce. Keys
 * are at most 40 characters and values 500; up to 50 pairs an object
 * (https://docs.dodopayments.com/api-reference/metadata).
 */
export const ORG_METADATA_KEY = 'xecret_org_id';
export const CHECKOUT_NONCE_METADATA_KEY = 'xecret_checkout';

/**
 * `POST /checkouts`, as far as this server sends it.
 * https://docs.dodopayments.com/api-reference/checkout-sessions/create
 */
interface DodoCheckoutRequest {
  product_cart: { product_id: string; quantity: number }[];
  /** `{ customer_id }` attaches an existing customer; `{ email, name? }` describes a new one. */
  customer: { customer_id: string } | { email: string; name?: string };
  /** "Set to true if a new customer object should be created." */
  always_create_new_customer?: boolean;
  return_url: string;
  metadata: Record<string, string>;
  billing_address?: { country: string };
  billing_currency?: string;
  feature_flags: { allow_currency_selection: boolean; allow_customer_editing_country?: boolean };
}

/**
 * `POST /subscriptions/{id}/change-plan` (and `…/preview`), as far as this
 * server sends it. Without `cancel_scheduled_change_plan`, Dodo answers 409
 * while another change is scheduled for the period end — which is what a seat
 * push must wait for rather than override (`seats.ts`).
 * https://docs.dodopayments.com/api-reference/subscriptions/change-plan
 */
interface DodoChangePlanRequest {
  product_id: string;
  /** "Must be at least 1." */
  quantity: number;
  proration_billing_mode: PlanChange['proration'];
  /** `immediately` (Dodo's default) or `next_billing_date`, which schedules the change. */
  effective_at: PlanChange['effectiveAt'];
  /** `prevent_change` keeps the current plan until payment succeeds; `apply_change` is Dodo's default. */
  on_payment_failure: PlanChange['onPaymentFailure'];
}

export class DodoClient implements BillingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  async createCheckoutSession(
    request: CheckoutRequest,
  ): Promise<{ sessionId: string; url: string }> {
    const byEmail = !('customerId' in request.customer);
    const body: DodoCheckoutRequest = {
      product_cart: [{ product_id: request.productId, quantity: request.quantity }],
      customer:
        'customerId' in request.customer
          ? { customer_id: request.customer.customerId }
          : {
              email: request.customer.email,
              ...(request.customer.name ? { name: request.customer.name } : {}),
            },
      // A customer per organisation, never per email address: see `CheckoutRequest.customer`.
      ...(byEmail ? { always_create_new_customer: true } : {}),
      return_url: request.returnUrl,
      metadata: {
        [ORG_METADATA_KEY]: request.orgId,
        [CHECKOUT_NONCE_METADATA_KEY]: request.nonce,
      },
      ...(request.regionLock
        ? {
            billing_address: { country: request.regionLock.country },
            billing_currency: request.regionLock.currency,
          }
        : {}),
      feature_flags: {
        // The PPP guardrail: the currency follows the billing country, and the
        // buyer does not get to choose one.
        allow_currency_selection: false,
        ...(request.regionLock ? { allow_customer_editing_country: false } : {}),
      },
    };
    const parsed = await this.call('POST', '/checkouts', dodoCheckoutSessionSchema, body);
    return { sessionId: parsed.session_id, url: parsed.checkout_url };
  }

  async changePlan(subscriptionId: string, change: PlanChange): Promise<void> {
    await this.call(
      'POST',
      `/subscriptions/${encodeURIComponent(subscriptionId)}/change-plan`,
      null,
      planChangeBody(change),
    );
  }

  async previewPlanChange(subscriptionId: string, change: PlanChange): Promise<PlanChangePreview> {
    const parsed = await this.call(
      'POST',
      `/subscriptions/${encodeURIComponent(subscriptionId)}/change-plan/preview`,
      dodoPlanPreviewSchema,
      planChangeBody(change),
    );
    return {
      currency: parsed.immediate_charge.summary.currency,
      amountMinor: parsed.immediate_charge.summary.total_amount,
    };
  }

  async getSubscription(subscriptionId: string): Promise<DodoSubscription> {
    return this.call(
      'GET',
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      dodoSubscriptionSchema,
    );
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<{ link: string }> {
    const query = new URLSearchParams({ return_url: returnUrl });
    const parsed = await this.call(
      'POST',
      `/customers/${encodeURIComponent(customerId)}/customer-portal/session?${query.toString()}`,
      dodoPortalSessionSchema,
    );
    return { link: parsed.link };
  }

  async ingestUsage(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (events.length > 1000) throw new Error('Dodo accepts at most 1000 events per request');
    await this.call('POST', '/events/ingest', null, {
      events: events.map((event) => ({
        event_id: event.eventId,
        customer_id: event.customerId,
        event_name: event.eventName,
        timestamp: event.timestamp.toISOString(),
      })),
    });
  }

  async cardExpiries(customerId: string): Promise<Map<string, { month: number; year: number }>> {
    const parsed = await this.call(
      'GET',
      `/customers/${encodeURIComponent(customerId)}/payment-methods`,
      dodoPaymentMethodsSchema,
    );
    const expiries = new Map<string, { month: number; year: number }>();
    for (const item of parsed.items) {
      const month = Number(item.card?.expiry_month);
      let year = Number(item.card?.expiry_year);
      if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) continue;
      if (year < 100) year += 2000;
      expiries.set(item.payment_method_id, { month, year });
    }
    return expiries;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodMiniType<T> | null,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(DODO_TIMEOUT_MS),
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : '';
      throw new DodoApiError(name === 'TimeoutError' ? 'timeout' : 'network', null);
    }

    if (!response.ok) {
      const code = await errorCode(response);
      // Belt and braces: a provider that quoted the request back could quote
      // the key. Such a code is dropped whole.
      const safe = code !== null && code.includes(this.apiKey) ? null : code;
      throw new DodoApiError(categoryOf(response.status), response.status, safe);
    }

    if (schema === null) {
      // Cancelled so the connection is released; the body is not read for
      // anything. Not awaited: a cancelled stream's promise is the runtime's
      // bookkeeping, and nothing here depends on when it settles.
      void response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new DodoApiError('malformed', response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new DodoApiError('malformed', response.status);
    return parsed.data;
  }
}

function planChangeBody(change: PlanChange): DodoChangePlanRequest {
  return {
    product_id: change.productId,
    quantity: change.quantity,
    proration_billing_mode: change.proration,
    effective_at: change.effectiveAt,
    on_payment_failure: change.onPaymentFailure,
  };
}

function categoryOf(status: number): DodoFailure {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_5xx';
  return 'invalid';
}

/**
 * The short code from an error body, if it has one — `{"code":"…"}` — scrubbed
 * and bounded. Never the message, which is where a request gets quoted back.
 */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).slice(0, 4096);
    const parsed = JSON.parse(text) as { code?: unknown; error_code?: unknown };
    const code = typeof parsed.code === 'string' ? parsed.code : parsed.error_code;
    // An error code is an identifier — `SUBSCRIPTION_NOT_ACTIVE` — and anything
    // that is not shaped like one is dropped rather than cleaned into one.
    if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) return null;
    return scrubText(code);
  } catch {
    return null;
  }
}

/** The production provider for a configured deployment. Replaced in tests. */
export function billingProvider(config: BillingConfig): BillingProvider {
  return new DodoClient(config.baseUrl, config.apiKey);
}
