import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '@xecret/core/audit';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { findCheckout, findSubscription } from '@xecret/db/repositories';
import type { Principal } from '../actor';
import { createLogger } from '../logging';
import type { LogEntry, RequestLog } from '../logging';
import type { BillingProvider } from './client';

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
const { DodoApiError } = await import('./client');

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
  // A subscription id is unique across organisations; each fixture gets its own.
  const row =
    typeof subscription['dodo_subscription_id'] === 'string'
      ? {
          ...subscription,
          dodo_subscription_id: `${subscription['dodo_subscription_id']}-${orgId.slice(0, 8)}`,
        }
      : subscription;
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
      regionLock: null,
    });
    expect(await findCheckout(t.db, 'cks_example0001')).toMatchObject({
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
    const { slug } = await seedOrg({
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
      customer: { customerId: 'cus_returning0001' },
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
    const { slug } = await seedOrg(SUBSCRIBED);
    const link = 'https://customer.dodopayments.com/session/example-not-a-real-key';
    dodo.createPortalSession.mockResolvedValue({ link });

    const answer = await call(portalRoute.POST, 'POST', slug, '/portal');

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ link });
    expect(dodo.createPortalSession).toHaveBeenCalledWith(
      'cus_example0001',
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
