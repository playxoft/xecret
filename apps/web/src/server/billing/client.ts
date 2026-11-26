import type * as z from 'zod/mini';
import { scrubText } from '../logging';
import type { BillingConfig } from './config';
import {
  dodoCheckoutSessionSchema,
  dodoDiscountSchema,
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
  /**
   * A discount code xecret issued and the server already checked (migration
   * 0035), or `null`. Pre-applied; the buyer cannot remove it.
   */
  discountCode: string | null;
}

/**
 * A discount code xecret's admin page asks Dodo to create (migration 0035).
 * Always restricted to products of this deployment's catalogue: the Dodo
 * account is shared with other products, and a code of ours must never take
 * anything off one of theirs.
 */
export interface DiscountRequest {
  code: string;
  /** Shown in Dodo's dashboard only. */
  name: string;
  type: 'percentage' | 'flat';
  /** Basis points for `percentage`; the currency's minor unit for `flat`. */
  amount: number;
  /** ISO-4217, for `flat`. */
  currency: string | null;
  /** Billing cycles it lasts; `null` for every renewal. */
  cycles: number | null;
  productIds: readonly string[];
  usageLimit: number | null;
  expiresAt: Date | null;
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
   *    once; `readTrial` reads the trial as over when that payment moves
   *    Dodo's next charge past the trial's booked end — a declined charge
   *    moves nothing.
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
  /** Creates a discount code; answers its id. */
  createDiscount(request: DiscountRequest): Promise<{ discountId: string }>;
  /** Deletes a discount code, so nothing can redeem it any more. */
  deleteDiscount(discountId: string): Promise<void>;
  /**
   * The id of the discount this server created under `code` — only when its
   * metadata says it is ours: the account is shared, and another product's
   * code of the same name must never be touched. `null` when there is none.
   */
  findOwnDiscount(code: string): Promise<string | null>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Dodo's metadata keys for our organisation id and the checkout's nonce. Keys
 * are at most 40 characters and values 500; up to 50 pairs an object
 * (https://docs.dodopayments.com/api-reference/metadata).
 */
export const ORG_METADATA_KEY = 'xecret_org_id';
export const CHECKOUT_NONCE_METADATA_KEY = 'xecret_checkout';
/** On a discount this server created: its code, so `findOwnDiscount` can tell it from another product's. */
export const DISCOUNT_METADATA_KEY = 'xecret_promo_code';

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
  /** Pre-applied codes, in order; the buyer cannot change them while the box is hidden. */
  discount_codes?: string[];
  feature_flags: {
    allow_currency_selection: boolean;
    allow_customer_editing_country?: boolean;
    /** The checkout page's own code box. Shown by Dodo unless this says `false`. */
    allow_discount_code: boolean;
  };
}

/**
 * `POST /discounts`, as far as this server sends it.
 * https://docs.dodopayments.com/api-reference/discounts/create-discount
 */
interface DodoDiscountRequest {
  code: string;
  name: string;
  type: 'percentage' | 'flat';
  /** "The discount amount in basis points" — for a flat code, its amount in the default currency. */
  amount: number;
  currency_options?: {
    currency: string;
    is_default: boolean;
    max_amount_possible: number;
    minimum_subtotal: number;
  }[];
  restricted_to: string[];
  subscription_cycles?: number;
  usage_limit?: number;
  expires_at?: string;
  customer_eligibility: 'any';
  metadata: Record<string, string>;
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
      ...(request.discountCode !== null ? { discount_codes: [request.discountCode] } : {}),
      feature_flags: {
        // The PPP guardrail: the currency follows the billing country, and the
        // buyer does not get to choose one.
        allow_currency_selection: false,
        ...(request.regionLock ? { allow_customer_editing_country: false } : {}),
        // Dodo's own code box stays hidden, always. The Dodo account is shared
        // with other products, so a code typed there could be anybody's — and
        // a code of ours typed there would skip every check this server makes
        // (who it is for, when it expires, whether it was revoked). A code is
        // applied only by being sent above, after `discountForCheckout`.
        allow_discount_code: false,
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

  async createDiscount(request: DiscountRequest): Promise<{ discountId: string }> {
    if (request.productIds.length === 0) {
      // Dodo reads an empty restriction as "every product" — on an account
      // shared with other products, the one shape a code of ours must never be.
      throw new Error('A discount must be restricted to at least one product');
    }
    const body: DodoDiscountRequest = {
      code: request.code,
      name: request.name,
      type: request.type,
      amount: request.amount,
      ...(request.type === 'flat' && request.currency !== null
        ? {
            currency_options: [
              {
                currency: request.currency,
                is_default: true,
                max_amount_possible: request.amount,
                minimum_subtotal: 0,
              },
            ],
          }
        : {}),
      restricted_to: [...request.productIds],
      ...(request.cycles !== null ? { subscription_cycles: request.cycles } : {}),
      ...(request.usageLimit !== null ? { usage_limit: request.usageLimit } : {}),
      ...(request.expiresAt !== null ? { expires_at: request.expiresAt.toISOString() } : {}),
      // Who may use it is this server's check (`allowed_emails`), made before
      // the code is ever sent: a checkout creates a new Dodo customer per
      // organisation, so Dodo's own per-customer list could not name them.
      customer_eligibility: 'any',
      metadata: { [DISCOUNT_METADATA_KEY]: request.code },
    };
    const parsed = await this.call('POST', '/discounts', dodoDiscountSchema, body);
    if (parsed.code.toUpperCase() !== request.code) {
      // Dodo stored a different code from the one asked for. The code on our
      // row is what owners type and what checkout sends, so a mismatch would
      // make it apply nothing — deleted again here, where its id is known, so
      // nothing is left at Dodo that this server has no row for, and refused.
      await this.deleteDiscount(parsed.discount_id).catch(() => undefined);
      throw new DodoApiError('malformed', null, 'code_mismatch');
    }
    return { discountId: parsed.discount_id };
  }

  async findOwnDiscount(code: string): Promise<string | null> {
    let parsed: z.infer<typeof dodoDiscountSchema>;
    try {
      parsed = await this.call(
        'GET',
        `/discounts/code/${encodeURIComponent(code)}`,
        dodoDiscountSchema,
      );
    } catch (cause) {
      if (cause instanceof DodoApiError && cause.category === 'not_found') return null;
      throw cause;
    }
    return parsed.metadata?.[DISCOUNT_METADATA_KEY] === code ? parsed.discount_id : null;
  }

  async deleteDiscount(discountId: string): Promise<void> {
    await this.call('DELETE', `/discounts/${encodeURIComponent(discountId)}`, null);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
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
