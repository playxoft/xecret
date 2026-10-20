import { describe, expect, it, vi } from 'vitest';
import { DodoApiError, DodoClient, ORG_METADATA_KEY } from './client';

/**
 * The Dodo client against a stubbed `fetch` — never the real API. What is
 * asserted is what leaves this server (the request) and what a failure is
 * allowed to carry back into it (a category, never a body).
 */

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** For a call that must fail: reaching here is the test failing. */
function neverResolves(): never {
  throw new Error('expected the call to fail');
}

const BASE = 'https://test.dodopayments.com';
/** Names itself as a fixture — see `.gitleaks.toml`. */
const KEY = 'dodo-example-not-a-real-key';

function stub(response: Response | (() => Promise<Response>)) {
  return vi.fn<Fetcher>(async () =>
    typeof response === 'function' ? response() : response.clone(),
  );
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function sentBody(fetcher: ReturnType<typeof stub>): Record<string, unknown> {
  const init = fetcher.mock.calls[0]![1];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function sentInit(fetcher: ReturnType<typeof stub>): { url: string; init: RequestInit } {
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

const SUBSCRIPTION = {
  subscription_id: 'sub_123',
  status: 'active',
  product_id: 'pdt_team_m',
  quantity: 4,
  currency: 'INR',
  customer: { customer_id: 'cus_TV52uJWWXt2yIoBBxpjaa', email: 'owner@example.com', name: 'A' },
  billing: { country: 'IN', city: 'Bengaluru', street: '1 MG Road' },
  metadata: { [ORG_METADATA_KEY]: '0192f0c4-5b1e-7a3c-8d2e-3f4a5b6c7d8e' },
  next_billing_date: '2026-11-20T00:00:00Z',
  previous_billing_date: '2026-10-20T00:00:00Z',
  cancel_at_next_billing_date: false,
  trial_period_days: 0,
  created_at: '2026-10-20T00:00:00Z',
  recurring_pre_tax_amount: 239600,
  addons: [],
};

describe('createCheckoutSession', () => {
  it('sends the product, the seats, our org id and the PPP flags — and nothing from the browser', async () => {
    const fetcher = stub(ok({ session_id: 'cks_1', checkout_url: 'https://checkout.dodo/cks_1' }));
    const client = new DodoClient(BASE, KEY, fetcher);

    const session = await client.createCheckoutSession({
      productId: 'pdt_team_y',
      quantity: 3,
      customer: { email: 'owner@example.com', name: 'Owner' },
      returnUrl: 'https://xecret.playxoft.com/app/acme/settings/billing?status=returned',
      orgId: 'org-uuid',
      regionLock: null,
    });

    expect(session).toEqual({ sessionId: 'cks_1', url: 'https://checkout.dodo/cks_1' });
    const { url, init } = sentInit(fetcher);
    expect(url).toBe(`${BASE}/checkouts`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(sentBody(fetcher)).toEqual({
      product_cart: [{ product_id: 'pdt_team_y', quantity: 3 }],
      customer: { email: 'owner@example.com', name: 'Owner' },
      return_url: 'https://xecret.playxoft.com/app/acme/settings/billing?status=returned',
      metadata: { [ORG_METADATA_KEY]: 'org-uuid' },
      feature_flags: { allow_currency_selection: false },
    });
  });

  it('pins a region-locked organisation to the country and currency it was first billed in', async () => {
    const fetcher = stub(ok({ session_id: 'cks_1', checkout_url: 'https://checkout.dodo/cks_1' }));
    await new DodoClient(BASE, KEY, fetcher).createCheckoutSession({
      productId: 'pdt_pro_m',
      quantity: 1,
      customer: { customerId: 'cus_existing0001' },
      returnUrl: 'https://x/r',
      orgId: 'org-uuid',
      regionLock: { country: 'IN', currency: 'INR' },
    });
    expect(sentBody(fetcher)).toMatchObject({
      customer: { customer_id: 'cus_existing0001' },
      billing_address: { country: 'IN' },
      billing_currency: 'INR',
      feature_flags: { allow_currency_selection: false, allow_customer_editing_country: false },
    });
  });
});

describe('changePlan and previewPlanChange', () => {
  it('names the product, quantity and proration, and never applies a change the card did not pay for', async () => {
    const fetcher = stub(new Response(null, { status: 200 }));
    await new DodoClient(BASE, KEY, fetcher).changePlan('sub_123', {
      productId: 'pdt_team_m',
      quantity: 6,
      proration: 'difference_immediately',
      effectiveAt: 'immediately',
      onPaymentFailure: 'apply_change',
    });
    expect(sentInit(fetcher).url).toBe(`${BASE}/subscriptions/sub_123/change-plan`);
    expect(sentBody(fetcher)).toEqual({
      product_id: 'pdt_team_m',
      quantity: 6,
      proration_billing_mode: 'difference_immediately',
      effective_at: 'immediately',
      on_payment_failure: 'apply_change',
    });
  });

  it('reads the immediate charge of a preview', async () => {
    const fetcher = stub(
      ok({
        immediate_charge: {
          summary: { currency: 'USD', total_amount: 1234, tax: 0 },
          line_items: [],
        },
        new_plan: SUBSCRIPTION,
      }),
    );
    const preview = await new DodoClient(BASE, KEY, fetcher).previewPlanChange('sub_123', {
      productId: 'pdt_team_y',
      quantity: 4,
      proration: 'prorated_immediately',
      effectiveAt: 'immediately',
      onPaymentFailure: 'prevent_change',
    });
    expect(preview).toEqual({ currency: 'USD', amountMinor: 1234 });
    expect(sentInit(fetcher).url).toBe(`${BASE}/subscriptions/sub_123/change-plan/preview`);
  });

  it('encodes a path segment, so an id cannot reach another endpoint', async () => {
    const fetcher = stub(ok(SUBSCRIPTION));
    await new DodoClient(BASE, KEY, fetcher).getSubscription('../customers/cus_x');
    expect(sentInit(fetcher).url).toBe(`${BASE}/subscriptions/..%2Fcustomers%2Fcus_x`);
  });
});

describe('getSubscription', () => {
  it('keeps only the declared fields — no address, no name, no email', async () => {
    const fetcher = stub(ok(SUBSCRIPTION));
    const subscription = await new DodoClient(BASE, KEY, fetcher).getSubscription('sub_123');
    expect(subscription.quantity).toBe(4);
    expect(subscription.billing).toEqual({ country: 'IN' });
    expect(subscription.customer).toEqual({ customer_id: 'cus_TV52uJWWXt2yIoBBxpjaa' });
    expect(JSON.stringify(subscription)).not.toContain('owner@example.com');
    expect(JSON.stringify(subscription)).not.toContain('MG Road');
  });

  it('refuses a status nobody defined rather than guessing at it', async () => {
    const fetcher = stub(ok({ ...SUBSCRIPTION, status: 'zombie' }));
    await expect(
      new DodoClient(BASE, KEY, fetcher).getSubscription('sub_123'),
    ).rejects.toMatchObject({ category: 'malformed' });
  });
});

describe('createPortalSession', () => {
  it('passes the return URL as a query parameter, as the API takes it', async () => {
    const fetcher = stub(ok({ link: 'https://portal.dodo/session/abc' }));
    const session = await new DodoClient(BASE, KEY, fetcher).createPortalSession(
      'cus_TV52uJWWXt2yIoBBxpjaa',
      'https://xecret.playxoft.com/app/acme/settings/billing',
    );
    expect(session.link).toBe('https://portal.dodo/session/abc');
    expect(sentInit(fetcher).url).toBe(
      `${BASE}/customers/cus_TV52uJWWXt2yIoBBxpjaa/customer-portal/session?return_url=https%3A%2F%2Fxecret.playxoft.com%2Fapp%2Facme%2Fsettings%2Fbilling`,
    );
  });
});

describe('ingestUsage', () => {
  it('sends deterministic event ids and never more than one batch', async () => {
    const fetcher = stub(ok({ ingested_count: 2 }));
    const client = new DodoClient(BASE, KEY, fetcher);
    const at = new Date('2026-10-20T12:00:00Z');
    await client.ingestUsage([
      { eventId: 'org:2026-10-01:0', customerId: 'cus_a1234567', eventName: 'kilo', timestamp: at },
      { eventId: 'org:2026-10-01:1', customerId: 'cus_a1234567', eventName: 'kilo', timestamp: at },
    ]);
    expect(sentBody(fetcher)).toEqual({
      events: [
        {
          event_id: 'org:2026-10-01:0',
          customer_id: 'cus_a1234567',
          event_name: 'kilo',
          timestamp: '2026-10-20T12:00:00.000Z',
        },
        {
          event_id: 'org:2026-10-01:1',
          customer_id: 'cus_a1234567',
          event_name: 'kilo',
          timestamp: '2026-10-20T12:00:00.000Z',
        },
      ],
    });

    await client.ingestUsage([]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const tooMany = Array.from({ length: 1001 }, (_, index) => ({
      eventId: `e${index}`,
      customerId: 'cus_a1234567',
      eventName: 'kilo',
      timestamp: at,
    }));
    await expect(client.ingestUsage(tooMany)).rejects.toThrow(/at most 1000/);
  });
});

describe('cardExpiries', () => {
  it('reads card expiry months and years, and skips anything that is not a card date', async () => {
    const fetcher = stub(
      ok({
        items: [
          {
            payment_method: 'card',
            payment_method_id: 'pm_1',
            card: { expiry_month: '11', expiry_year: '26', last4_digits: '4242' },
          },
          { payment_method: 'upi', payment_method_id: 'pm_2', card: null },
          {
            payment_method: 'card',
            payment_method_id: 'pm_3',
            card: { expiry_month: '13', expiry_year: '2027' },
          },
        ],
      }),
    );
    const expiries = await new DodoClient(BASE, KEY, fetcher).cardExpiries('cus_a1234567');
    expect([...expiries.entries()]).toEqual([['pm_1', { month: 11, year: 2026 }]]);
  });
});

describe('failures', () => {
  it('carries a category and a short code, never the body', async () => {
    const body = JSON.stringify({
      code: 'SUBSCRIPTION_NOT_ACTIVE',
      message: 'Subscription for owner@example.com (cus_TV52uJWWXt2yIoBBxpjaa) is not active',
    });
    const fetcher = stub(new Response(body, { status: 422 }));
    const failure = await new DodoClient(BASE, KEY, fetcher)
      .changePlan('sub_123', {
        productId: 'p',
        quantity: 1,
        proration: 'difference_immediately',
        effectiveAt: 'immediately',
        onPaymentFailure: 'apply_change',
      })
      .then(neverResolves, (cause: unknown) => cause);

    expect(failure).toBeInstanceOf(DodoApiError);
    expect(failure).toMatchObject({ category: 'invalid', status: 422, retryable: false });
    expect((failure as DodoApiError).detail).toBe('SUBSCRIPTION_NOT_ACTIVE');
    const everything = `${(failure as Error).message} ${(failure as DodoApiError).detail ?? ''}`;
    expect(everything).not.toContain('owner@example.com');
    expect(everything).not.toContain('cus_TV52');
  });

  it('marks what a retry could fix', async () => {
    const cases: [number, string, boolean][] = [
      [401, 'unauthorized', false],
      [404, 'not_found', false],
      [409, 'conflict', false],
      [429, 'rate_limited', true],
      [503, 'upstream_5xx', true],
    ];
    for (const [status, category, retryable] of cases) {
      const fetcher = stub(new Response('{}', { status }));
      const failure = await new DodoClient(BASE, KEY, fetcher)
        .getSubscription('sub_1')
        .then(neverResolves, (cause: unknown) => cause as DodoApiError);
      expect(failure, String(status)).toMatchObject({ category, retryable });
    }
  });

  it('turns a network failure and a timeout into retryable categories', async () => {
    const network = vi.fn<Fetcher>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(new DodoClient(BASE, KEY, network).getSubscription('s')).rejects.toMatchObject({
      category: 'network',
      retryable: true,
    });

    const timeout = vi.fn<Fetcher>(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    await expect(new DodoClient(BASE, KEY, timeout).getSubscription('s')).rejects.toMatchObject({
      category: 'timeout',
    });
  });

  it('never puts the API key in an error', async () => {
    const fetcher = stub(new Response(`{"code":"bad key ${KEY}"}`, { status: 401 }));
    const failure = await new DodoClient(BASE, KEY, fetcher)
      .getSubscription('s')
      .then(neverResolves, (cause: unknown) => cause as DodoApiError);
    expect(`${failure.message} ${failure.detail ?? ''}`).not.toContain(KEY);
  });
});
