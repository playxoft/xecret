import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import type { AuditRecord } from '@xecret/core/audit';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { findCheckout, findSubscription } from '@xecret/db/repositories';
import type { Principal } from '../actor';
import { createLogger } from '../logging';
import type { LogEntry, RequestLog } from '../logging';
import type { BillingProvider, CheckoutRequest } from './client';

/**
 * The owner-facing billing routes, end to end against a real database, with
 * Dodo stubbed at `billingProvider` — **no request here reaches Dodo**.
 *
 * What is asserted for every money-moving route: who may (owners, in a browser
 * session, never a token or an admin), what the client may not decide (seats,
 * price, currency), what reaches Dodo, and that the route itself grants
 * nothing — only the webhook does.
 */

const ORIGIN = 'https://xecret.playxoft.com';

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const dodo = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  changePlan: vi.fn(),
  previewPlanChange: vi.fn(),
  getSubscription: vi.fn(),
  createPortalSession: vi.fn(),
  ingestUsage: vi.fn(),
  cardExpiries: vi.fn(),
}));

vi.mock('../context', () => context);
vi.mock('../actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actor')>()),
  ...actor,
}));
vi.mock('../audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));
vi.mock('../logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logging')>()),
  createRequestLog: logging.createRequestLog,
}));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: (): BillingProvider => dodo as unknown as BillingProvider,
}));

const statusRoute = await import('@/app/api/orgs/[orgSlug]/billing/route');
const checkoutRoute = await import('@/app/api/orgs/[orgSlug]/billing/checkout/route');
const changeRoute = await import('@/app/api/orgs/[orgSlug]/billing/change/route');
const portalRoute = await import('@/app/api/orgs/[orgSlug]/billing/portal/route');
const webhookRoute = await import('@/app/api/billing/webhook/route');
const { DodoApiError, DodoClient } = await import('./client');

let t: TestDatabase;
let lines: LogEntry[] = [];
let audit: AuditRecord[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown> = {};
let caller: Principal;

const BILLING_ENV = {
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: `whsec_${btoa('example-not-a-real-key-32-bytes!')}`,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(dodo)) fn.mockReset();
  lines = [];
  audit = [];
  deferred = [];
  env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production', ...BILLING_ENV };

  logging.createRequestLog.mockImplementation((_env: unknown, base: Record<string, unknown>) =>
    createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
      base,
    }),
  );
  context.workerContext.mockImplementation(async () => ({ env, ctx: { waitUntil: () => {} } }));
  context.createServiceContext.mockImplementation(
    async (
      request: Request,
      _worker: unknown,
      requestId: string,
      log: RequestLog,
      startedAt: number,
    ) => ({
      env,
      db: t.db,
      envelope: {},
      meta: {
        requestId,
        rayId: null,
        ipAddress: '203.0.113.5',
        userAgent: 'vitest',
        method: request.method,
        path: new URL(request.url).pathname,
        startedAt,
      },
      log: log.logger,
      bindLog: log.bind,
      waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
      settled: () => Promise.allSettled(deferred),
      dispose: () => {},
    }),
  );
  actor.authenticate.mockImplementation(async () => ({
    principal: caller,
    source: caller.kind === 'user' ? 'cookie' : 'bearer',
  }));
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  auditSink.write.mockImplementation(async (events: AuditRecord[]) => {
    audit.push(...events);
  });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `person-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, email],
  );
  return { id, email };
}

function sessionOf(user: { id: string; email: string }): Principal {
  return {
    kind: 'user',
    sessionId: randomUUID(),
    user: {
      id: user.id,
      email: user.email,
      emailVerified: true,
      displayName: 'Owner',
      avatarUrl: null,
    },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
}

async function addMember(orgId: string, userId: string, role: string, status = 'active') {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), orgId, userId, role, status],
  );
}

async function seedOrg(
  subscription: Record<string, unknown> = {},
): Promise<{ orgId: string; slug: string; owner: { id: string; email: string } }> {
  const owner = await seedUser();
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, owner.id],
  );
  // A subscription id is unique across organisations, and a customer is one
  // organisation's alone: each fixture gets its own of both.
  const row = { ...subscription };
  for (const column of ['dodo_subscription_id', 'dodo_customer_id'] as const) {
    if (typeof row[column] === 'string') row[column] = `${row[column]}-${orgId.slice(0, 8)}`;
  }
  const columns = ['org_id', ...Object.keys(row)];
  const values = [orgId, ...Object.values(row)];
  await t.pg.query(
    `insert into org_subscriptions (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  );
  await addMember(orgId, owner.id, 'owner');
  caller = sessionOf(owner);
  return { orgId, slug, owner };
}

/** A Team subscription Dodo bills, as the webhook would have left it. */
const SUBSCRIBED = {
  plan: 'team',
  billing_interval: 'monthly',
  seats: 3,
  currency: 'USD',
  billing_country: 'US',
  dodo_customer_id: 'cus_example0001',
  dodo_subscription_id: 'sub_example0001',
  dodo_product_id: 'pdt_team_m',
  current_period_end: new Date(Date.now() + 20 * 86_400_000),
};

async function call(
  handler: (
    request: Request,
    args?: { params?: Promise<{ orgSlug: string }> },
  ) => Promise<Response>,
  method: string,
  slug: string,
  path = '',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${ORIGIN}/api/orgs/${slug}/billing${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ orgSlug: slug }) },
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const checkout = (slug: string, body: unknown) =>
  call(checkoutRoute.POST, 'POST', slug, '/checkout', body);

/* ── who may ──────────────────────────────────────────────────────────────── */

describe('who may manage billing', () => {
  it('lets an owner read the billing screen', async () => {
    const { slug } = await seedOrg();
    const answer = await call(statusRoute.GET, 'GET', slug);
    expect(answer.status).toBe(200);
    expect(answer.body['billing']).toMatchObject({
      enabled: true,
      mode: 'test_mode',
      plan: 'free',
      managedBy: 'none',
      actions: { checkout: true, changePlan: false, portal: false },
    });
  });

  it('refuses an admin — by capability, not by a hidden link — and files what they attempted', async () => {
    const { orgId, slug } = await seedOrg();
    const admin = await seedUser();
    await addMember(orgId, admin.id, 'admin');
    caller = sessionOf(admin);

    expect((await call(statusRoute.GET, 'GET', slug)).status).toBe(403);
    const answer = await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(answer.status).toBe(403);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
    expect(
      audit.some(
        (record) => record.action === 'billing.checkout_started' && record.outcome === 'denied',
      ),
    ).toBe(true);
  });

  it('refuses a CLI token outright — a bearer credential may not spend money', async () => {
    const { slug, owner } = await seedOrg();
    caller = {
      kind: 'cliToken',
      tokenId: randomUUID(),
      userId: owner.id,
      orgId: null,
      signIn: { method: 'password', ssoWorkosOrgId: null },
    } as unknown as Principal;
    expect((await checkout(slug, { plan: 'team', interval: 'monthly' })).status).toBe(403);
    expect((await call(portalRoute.POST, 'POST', slug, '/portal')).status).toBe(403);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('answers a stranger 404, never confirming the organisation exists', async () => {
    const { slug } = await seedOrg();
    caller = sessionOf(await seedUser());
    expect((await call(statusRoute.GET, 'GET', slug)).status).toBe(404);
  });
});

/* ── checkout ─────────────────────────────────────────────────────────────── */

describe('checkout', () => {
  it('sends Dodo the plan’s product, the counted seats and our org id — and grants nothing', async () => {
    const { orgId, slug, owner } = await seedOrg();
    // Two more seated members — one suspended, which is never a discount — and
    // an open invitation, which is not billed until accepted.
    const developer = await seedUser();
    const suspended = await seedUser();
    await addMember(orgId, developer.id, 'developer');
    await addMember(orgId, suspended.id, 'viewer', 'suspended');
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'later@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
      [randomUUID(), orgId, new Uint8Array(32).fill(3), owner.id],
    );
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: 'cks_example0001',
      url: 'https://test.checkout.dodopayments.com/session/cks_example0001',
    });

    const answer = await checkout(slug, { plan: 'pro', interval: 'yearly' });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      url: 'https://test.checkout.dodopayments.com/session/cks_example0001',
    });
    expect(dodo.createCheckoutSession).toHaveBeenCalledWith({
      productId: 'pdt_pro_y',
      quantity: 3,
      customer: { email: owner.email, name: 'Owner' },
      returnUrl: `${ORIGIN}/app/${slug}/settings/billing?checkout=returned`,
      orgId,
      // 128 random bits, base64url: what binds the subscription to this checkout.
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      regionLock: null,
    });
    const sentNonce = (dodo.createCheckoutSession.mock.calls[0]![0] as { nonce: string }).nonce;
    expect(await findCheckout(t.db, 'cks_example0001')).toMatchObject({
      nonce: sentNonce,
      orgId,
      plan: 'pro',
      billingInterval: 'yearly',
      quantity: 3,
      createdBy: owner.id,
    });
    // The return from checkout grants nothing: still Free until the webhook.
    expect((await findSubscription(t.db, orgId))?.plan).toBe('free');
    expect(audit.find((record) => record.action === 'billing.checkout_started')?.metadata).toEqual({
      plan: 'pro',
      billingInterval: 'yearly',
      seatCount: 3,
    });
  });

  it('floors the seats at the plan’s minimum', async () => {
    const { slug } = await seedOrg();
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/1',
    });
    await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(dodo.createCheckoutSession.mock.calls[0]![0]).toMatchObject({ quantity: 3 });
  });

  it('takes no seat count, price or currency from the client', async () => {
    const { slug } = await seedOrg();
    for (const extra of [
      { quantity: 1 },
      { price: 1 },
      { currency: 'INR' },
      { productId: 'pdt_x' },
    ]) {
      const answer = await checkout(slug, { plan: 'team', interval: 'monthly', ...extra });
      expect(answer.status, JSON.stringify(extra)).toBe(422);
    }
    expect((await checkout(slug, { plan: 'enterprise', interval: 'monthly' })).status).toBe(422);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('pins a region-locked organisation to its country and currency', async () => {
    const { orgId, slug } = await seedOrg({
      region_locked_until: new Date(Date.now() + 100 * 86_400_000),
      billing_country: 'IN',
      currency: 'INR',
      dodo_customer_id: 'cus_returning0001',
    });
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/2',
    });
    await checkout(slug, { plan: 'team', interval: 'yearly' });
    expect(dodo.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
      customer: { customerId: `cus_returning0001-${orgId.slice(0, 8)}` },
      regionLock: { country: 'IN', currency: 'INR' },
    });
  });

  it('refuses a second checkout for a subscribed organisation — it would charge twice', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    const answer = await checkout(slug, { plan: 'pro', interval: 'monthly' });
    expect(answer.status).toBe(409);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses checkout where support set the plan by hand', async () => {
    const { slug } = await seedOrg({ plan: 'enterprise', billing_interval: 'yearly', seats: 25 });
    expect((await checkout(slug, { plan: 'team', interval: 'yearly' })).status).toBe(409);
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('says plainly when this installation takes no payments', async () => {
    const { slug } = await seedOrg();
    env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' };
    const answer = await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(answer.status).toBe(409);
    expect((await call(statusRoute.GET, 'GET', slug)).body['billing']).toMatchObject({
      enabled: false,
      actions: { checkout: false, changePlan: false, portal: false },
    });
  });

  it('records nothing when Dodo cannot be reached, and says nothing was charged', async () => {
    const { orgId, slug } = await seedOrg();
    dodo.createCheckoutSession.mockRejectedValue(new DodoApiError('upstream_5xx', 503));
    const answer = await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toContain('nothing was changed or charged');
    const rows = await t.pg.query(`select 1 from billing_checkouts where org_id = $1`, [orgId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses a checkout for a Free row recorded in the other Dodo mode — before anything is charged', async () => {
    // A live-mode customer left on a Free row, on this test-mode deployment.
    const { orgId, slug } = await seedOrg({
      dodo_customer_id: 'cus_livemode01',
      dodo_mode: 'live_mode',
    });
    const answer = await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.body)).toContain('different payment environment');
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
    const rows = await t.pg.query(`select 1 from billing_checkouts where org_id = $1`, [orgId]);
    expect(rows.rows).toHaveLength(0);
    expect((await call(statusRoute.GET, 'GET', slug)).body['billing']).toMatchObject({
      actions: { checkout: false },
    });
  });

  it('refuses to send the browser to a checkout URL that is not https', async () => {
    const { slug } = await seedOrg();
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'javascript:alert(1)',
    });
    expect((await checkout(slug, { plan: 'team', interval: 'monthly' })).status).toBe(502);
  });
});

/* ── plan change ──────────────────────────────────────────────────────────── */

describe('changing plan', () => {
  it('previews an upgrade with Dodo’s own proration, and takes it at once', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    dodo.previewPlanChange.mockResolvedValue({ currency: 'USD', amountMinor: 9_120 });
    const preview = await call(changeRoute.GET, 'GET', slug, '/change?plan=team&interval=yearly');
    expect(preview.status).toBe(200);
    expect(preview.body['preview']).toEqual({ effective: 'now', seats: 3, charge: '$91.20' });
  });

  it('answers a downgrade’s preview without asking Dodo — it charges nothing now', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    const preview = await call(changeRoute.GET, 'GET', slug, '/change?plan=pro&interval=monthly');
    expect(preview.body['preview']).toEqual({ effective: 'renewal', seats: 1, charge: null });
    expect(dodo.previewPlanChange).not.toHaveBeenCalled();
  });

  it('asks Dodo for an upgrade now, prorated, never applied if the charge fails — and grants nothing itself', async () => {
    const { orgId, slug } = await seedOrg({
      ...SUBSCRIBED,
      plan: 'pro',
      billing_interval: 'monthly',
      seats: 2,
    });
    for (let index = 0; index < 3; index += 1)
      await addMember(orgId, (await seedUser()).id, 'developer');
    dodo.changePlan.mockResolvedValue(undefined);

    const answer = await call(changeRoute.POST, 'POST', slug, '/change', {
      plan: 'team',
      interval: 'monthly',
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ requested: true, effective: 'now' });
    expect(dodo.changePlan).toHaveBeenCalledWith(expect.stringMatching(/^sub_example0001-/), {
      productId: 'pdt_team_m',
      quantity: 4,
      proration: 'prorated_immediately',
      effectiveAt: 'immediately',
      onPaymentFailure: 'prevent_change',
    });
    expect((await findSubscription(t.db, orgId))?.plan).toBe('pro');
    expect(
      audit.find((record) => record.action === 'billing.plan_change_requested')?.metadata,
    ).toMatchObject({
      plan: 'team',
      previousPlan: 'pro',
      seatCount: 4,
    });
  });

  it('waits for the paid period to end before a downgrade', async () => {
    const { slug } = await seedOrg({
      ...SUBSCRIBED,
      billing_interval: 'yearly',
      dodo_product_id: 'pdt_team_y',
    });
    dodo.changePlan.mockResolvedValue(undefined);
    const answer = await call(changeRoute.POST, 'POST', slug, '/change', {
      plan: 'team',
      interval: 'monthly',
    });
    expect(answer.body).toEqual({ requested: true, effective: 'renewal' });
    expect(dodo.changePlan.mock.calls[0]![1]).toMatchObject({ effectiveAt: 'next_billing_date' });
  });

  it('refuses a move to where the organisation already is, and one with no subscription', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    expect(
      (await call(changeRoute.POST, 'POST', slug, '/change', { plan: 'team', interval: 'monthly' }))
        .status,
    ).toBe(400);
    const free = await seedOrg();
    expect(
      (
        await call(changeRoute.POST, 'POST', free.slug, '/change', {
          plan: 'team',
          interval: 'monthly',
        })
      ).status,
    ).toBe(409);
    expect(dodo.changePlan).not.toHaveBeenCalled();
  });

  it('says when a change is already waiting at Dodo', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    dodo.changePlan.mockRejectedValue(new DodoApiError('conflict', 409));
    const answer = await call(changeRoute.POST, 'POST', slug, '/change', {
      plan: 'pro',
      interval: 'monthly',
    });
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.body)).toContain('already waiting');
  });
});

/* ── the portal ───────────────────────────────────────────────────────────── */

describe('the customer portal', () => {
  it('hands an owner a link, back to the billing screen, and never records the link', async () => {
    const { orgId, slug } = await seedOrg(SUBSCRIBED);
    const link = 'https://customer.dodopayments.com/session/example-not-a-real-key';
    dodo.createPortalSession.mockResolvedValue({ link });

    const answer = await call(portalRoute.POST, 'POST', slug, '/portal');

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ link });
    expect(dodo.createPortalSession).toHaveBeenCalledWith(
      `cus_example0001-${orgId.slice(0, 8)}`,
      `${ORIGIN}/app/${slug}/settings/billing`,
    );
    expect(audit.some((record) => record.action === 'billing.portal_opened')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(link);
    expect(JSON.stringify(lines)).not.toContain(link);
  });

  it('refuses an organisation Dodo has no account for yet', async () => {
    const { slug } = await seedOrg();
    expect((await call(portalRoute.POST, 'POST', slug, '/portal')).status).toBe(409);
    expect(dodo.createPortalSession).not.toHaveBeenCalled();
  });
});

/* ── round 1 ──────────────────────────────────────────────────────────────── */

/** A request with an `Idempotency-Key`, as the billing screen sends one. */
async function callWithKey(
  handler: typeof checkoutRoute.POST,
  slug: string,
  path: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${ORIGIN}/api/orgs/${slug}/billing${path}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgSlug: slug }) },
  );
  await Promise.allSettled(deferred);
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

describe('a request asked twice is one request', () => {
  it('a checkout repeated with its key returns the same checkout — one session at Dodo, one record', async () => {
    const { slug } = await seedOrg();
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/once',
    });
    const key = randomUUID();
    const first = await callWithKey(
      checkoutRoute.POST,
      slug,
      '/checkout',
      { plan: 'team', interval: 'monthly' },
      key,
    );
    const second = await callWithKey(
      checkoutRoute.POST,
      slug,
      '/checkout',
      { plan: 'team', interval: 'monthly' },
      key,
    );
    expect(first).toEqual({ status: 200, body: { url: 'https://pay.example/once' } });
    expect(second).toEqual(first);
    expect(dodo.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(audit.filter((record) => record.action === 'billing.checkout_started')).toHaveLength(1);

    // The same key for a different request is refused, not answered with the wrong one.
    const other = await callWithKey(
      checkoutRoute.POST,
      slug,
      '/checkout',
      { plan: 'pro', interval: 'yearly' },
      key,
    );
    expect(other.status).toBe(400);
  });

  it('a plan change repeated with its key reaches Dodo once', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    dodo.changePlan.mockResolvedValue(undefined);
    const key = randomUUID();
    const body = { plan: 'team', interval: 'yearly' };
    const first = await callWithKey(changeRoute.POST, slug, '/change', body, key);
    const second = await callWithKey(changeRoute.POST, slug, '/change', body, key);
    expect(first.body).toEqual({ requested: true, effective: 'now' });
    expect(second.body).toEqual(first.body);
    expect(dodo.changePlan).toHaveBeenCalledTimes(1);
  });

  it('a request that failed gives its key back, so trying again works', async () => {
    const { slug } = await seedOrg();
    const key = randomUUID();
    dodo.createCheckoutSession.mockRejectedValueOnce(new DodoApiError('upstream_5xx', 503));
    expect(
      (
        await callWithKey(
          checkoutRoute.POST,
          slug,
          '/checkout',
          { plan: 'team', interval: 'monthly' },
          key,
        )
      ).status,
    ).toBe(503);
    dodo.createCheckoutSession.mockResolvedValue({
      sessionId: `cks_${randomUUID()}`,
      url: 'https://pay.example/retry',
    });
    expect(
      (
        await callWithKey(
          checkoutRoute.POST,
          slug,
          '/checkout',
          { plan: 'team', interval: 'monthly' },
          key,
        )
      ).body,
    ).toEqual({ url: 'https://pay.example/retry' });
  });

  it('a plan change Dodo did not answer in time says it may have gone through, and keeps its key', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    dodo.changePlan.mockRejectedValue(new DodoApiError('timeout', null));
    const key = randomUUID();
    const body = { plan: 'team', interval: 'yearly' };

    const first = await callWithKey(changeRoute.POST, slug, '/change', body, key);
    expect(first.status).toBe(503);
    const said = JSON.stringify(first.body);
    expect(said).toContain('may have gone through');
    expect(said).not.toContain('nothing was changed or charged');

    // Asked again with the same key: told it is in flight, never sent twice.
    dodo.changePlan.mockResolvedValue(undefined);
    const again = await callWithKey(changeRoute.POST, slug, '/change', body, key);
    expect(again.status).toBe(409);
    expect(dodo.changePlan).toHaveBeenCalledTimes(1);
  });

  it('a checkout Dodo did not answer in time claims nothing, and keeps its key too', async () => {
    const { slug } = await seedOrg();
    dodo.createCheckoutSession.mockRejectedValue(new DodoApiError('network', null));
    const key = randomUUID();
    const body = { plan: 'team', interval: 'monthly' };

    const first = await callWithKey(checkoutRoute.POST, slug, '/checkout', body, key);
    expect(first.status).toBe(503);
    const said = JSON.stringify(first.body);
    expect(said).toContain('may or may not have been created');
    expect(said).not.toContain('nothing was changed or charged');

    const again = await callWithKey(checkoutRoute.POST, slug, '/checkout', body, key);
    expect(again.status).toBe(409);
    expect(dodo.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a new checkout while a paid one is still being applied', async () => {
    // The payment linked the subscription; its `active` has not arrived yet.
    const { slug } = await seedOrg({
      dodo_subscription_id: 'sub_linked0001',
      dodo_customer_id: 'cus_linked0001',
    });
    const answer = await checkout(slug, { plan: 'team', interval: 'monthly' });
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.body)).toContain('would charge twice');
    expect(dodo.createCheckoutSession).not.toHaveBeenCalled();
    expect((await call(statusRoute.GET, 'GET', slug)).body['billing']).toMatchObject({
      actions: { checkout: false },
    });
  });
});

describe('the change preview', () => {
  it('is rate limited — each one is a call to Dodo', async () => {
    const { slug } = await seedOrg(SUBSCRIBED);
    env = { ...env, RL_MUTATION: { limit: async () => ({ success: false }) } };
    const preview = await call(changeRoute.GET, 'GET', slug, '/change?plan=team&interval=yearly');
    expect(preview.status).toBe(429);
    expect(dodo.previewPlanChange).not.toHaveBeenCalled();
  });
});

describe('the customer portal, round 1', () => {
  it('is opened only for a customer this organisation alone holds', async () => {
    // A row from before checkouts forced a customer per organisation.
    const shared = `cus_shared${randomUUID().slice(0, 8)}`;
    const { orgId, slug, owner } = await seedOrg(SUBSCRIBED);
    const other = await seedOrg(SUBSCRIBED);
    for (const id of [orgId, other.orgId]) {
      await t.pg.query(`update org_subscriptions set dodo_customer_id = $2 where org_id = $1`, [
        id,
        shared,
      ]);
    }
    caller = sessionOf(owner);
    const answer = await call(portalRoute.POST, 'POST', slug, '/portal');
    expect(answer.status).toBe(409);
    expect(dodo.createPortalSession).not.toHaveBeenCalled();
    expect(
      lines.some((line) => line.level === 'error' && /held by another/.test(line.message)),
    ).toBe(true);
  });

  it('is refused for a subscription from the other Dodo mode', async () => {
    const { slug } = await seedOrg({ ...SUBSCRIBED, dodo_mode: 'live_mode' });
    expect((await call(portalRoute.POST, 'POST', slug, '/portal')).status).toBe(409);
    expect(dodo.createPortalSession).not.toHaveBeenCalled();
  });
});

describe('one owner, two organisations', () => {
  const SECRET = BILLING_ENV.DODO_WEBHOOK_SECRET;

  /**
   * Dodo, at the fetch boundary, as its docs describe customers: a checkout
   * given an email reuses the customer that email already has — unless it is
   * told `always_create_new_customer`.
   */
  function fakeDodo() {
    const byEmail = new Map<string, string>();
    const sessions = new Map<string, { customerId: string }>();
    const flags: unknown[] = [];
    let next = 0;
    const fetcher = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        customer: { customer_id?: string; email?: string };
        always_create_new_customer?: boolean;
      };
      flags.push(body.always_create_new_customer);
      let customerId: string;
      if (body.customer.customer_id) {
        customerId = body.customer.customer_id;
      } else if (body.always_create_new_customer === true || !byEmail.has(body.customer.email!)) {
        next += 1;
        customerId = `cus_fake${String(next).padStart(8, '0')}`;
        byEmail.set(body.customer.email!, customerId);
      } else {
        customerId = byEmail.get(body.customer.email!)!;
      }
      next += 1;
      const sessionId = `cks_fake${String(next).padStart(8, '0')}`;
      sessions.set(sessionId, { customerId });
      return new Response(
        JSON.stringify({
          session_id: sessionId,
          checkout_url: `https://checkout.example/${sessionId}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { fetcher, sessions, flags };
  }

  it('gets a Dodo customer per organisation — never one portal over both', async () => {
    const fake = fakeDodo();
    dodo.createCheckoutSession.mockImplementation((request: unknown) =>
      new DodoClient(
        'https://test.dodopayments.com',
        'dodo-example-not-a-real-key',
        fake.fetcher,
      ).createCheckoutSession(request as CheckoutRequest),
    );
    dodo.changePlan.mockResolvedValue(undefined);

    const first = await seedOrg();
    const owner = first.owner;
    // A second organisation, owned by the same person.
    const secondId = randomUUID();
    const secondSlug = `acme-${secondId.slice(0, 8)}`;
    await t.pg.query(
      `insert into organizations (id, name, slug, created_by) values ($1, 'Acme Two', $2, $3)`,
      [secondId, secondSlug, owner.id],
    );
    await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [secondId]);
    await addMember(secondId, owner.id, 'owner');
    caller = sessionOf(owner);

    const paid: { orgId: string; sessionId: string }[] = [];
    for (const [orgId, slug] of [
      [first.orgId, first.slug],
      [secondId, secondSlug],
    ] as const) {
      expect((await checkout(slug, { plan: 'team', interval: 'monthly' })).status).toBe(200);
      const sessionId = [...fake.sessions.keys()].at(-1)!;
      paid.push({ orgId, sessionId });
    }
    // Every checkout by email asked Dodo for a customer of its own.
    expect(fake.flags).toEqual([true, true]);

    // Each checkout's first payment links its subscription and its customer.
    for (const { orgId, sessionId } of paid) {
      const id = `msg_${randomUUID().replaceAll('-', '')}`;
      const body = JSON.stringify({
        type: 'payment.succeeded',
        timestamp: new Date().toISOString(),
        data: {
          payment_id: `pay_${randomUUID().slice(0, 12)}`,
          subscription_id: `sub_${orgId.slice(0, 12)}`,
          checkout_session_id: sessionId,
          customer: { customer_id: fake.sessions.get(sessionId)!.customerId },
          billing: { country: 'US' },
          currency: 'USD',
        },
      });
      const at = new Date();
      const answer = await webhookRoute.POST(
        new Request(`${ORIGIN}/api/billing/webhook`, {
          method: 'POST',
          headers: {
            'webhook-id': id,
            'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
            'webhook-signature': new Webhook(SECRET).sign(id, at, body),
          },
          body,
        }),
      );
      expect(answer.status).toBe(200);
    }
    await Promise.allSettled(deferred);

    const one = (await findSubscription(t.db, first.orgId))!.dodoCustomerId;
    const two = (await findSubscription(t.db, secondId))!.dodoCustomerId;
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one).not.toBe(two);
  });
});

describe('the billing screen', () => {
  it('shows seats billed against seats used, the renewal, usage and nearby ceilings', async () => {
    const { orgId, slug } = await seedOrg({
      ...SUBSCRIBED,
      renewal_amount_minor: 5_700,
      current_period_start: new Date(Date.now() - 86_400_000),
    });
    await t.pg.query(
      `insert into org_usage_counters (org_id, period_start, secret_fetches)
       select org_id, current_period_start, 812000 from org_subscriptions where org_id = $1`,
      [orgId],
    );
    const answer = await call(statusRoute.GET, 'GET', slug);
    expect(answer.body['billing']).toMatchObject({
      plan: 'team',
      interval: 'monthly',
      managedBy: 'checkout',
      seats: { billed: 3, seated: 1, pendingInvitations: 0, minimum: 3 },
      currency: 'USD',
      renewalAmount: '$57.00',
      usage: { secretFetches: 812000, includedFetches: 1_000_000 },
      actions: { checkout: false, changePlan: true, portal: true },
    });
  });

  it('warns a Free organisation near the seat ceiling it is actually held to', async () => {
    const { orgId, slug, owner } = await seedOrg();
    for (let index = 0; index < 3; index += 1)
      await addMember(orgId, (await seedUser()).id, 'viewer');
    void owner;
    const answer = await call(statusRoute.GET, 'GET', slug);
    const warnings = (answer.body['billing'] as { warnings: unknown[] }).warnings;
    expect(warnings).toContainEqual({ resource: 'seats', limit: 5, current: 4, atLimit: false });
  });
});
