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
 * and an invoice needs a buyer. Our organisation id, as metadata, so a webhook
 * can be traced back. No member list, no secret, nothing from a vault.
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
  /** The buyer, by email — or the customer Dodo already has for this organisation. */
  customer: { customerId: string } | { email: string; name: string | null };
  returnUrl: string;
  /** Our organisation id. Dodo signs it back to us in every webhook. */
  orgId: string;
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
   * `difference_immediately` for seat changes (charge the difference on add,
   * credit on remove), `prorated_immediately` for an upgrade.
   */
  proration: 'difference_immediately' | 'prorated_immediately';
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

/** Dodo's metadata key for our organisation id. Under its 40-character limit. */
export const ORG_METADATA_KEY = 'xecret_org_id';

export class DodoClient implements BillingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  async createCheckoutSession(
    request: CheckoutRequest,
  ): Promise<{ sessionId: string; url: string }> {
    const body = {
      product_cart: [{ product_id: request.productId, quantity: request.quantity }],
      customer:
        'customerId' in request.customer
          ? { customer_id: request.customer.customerId }
          : {
              email: request.customer.email,
              ...(request.customer.name ? { name: request.customer.name } : {}),
            },
      return_url: request.returnUrl,
      metadata: { [ORG_METADATA_KEY]: request.orgId },
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

function planChangeBody(change: PlanChange) {
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
