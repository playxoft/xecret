import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import type { AuditRecord } from '@xecret/core/audit';
import { FREE_SEAT_LIMIT, isDataPlaneActive, UNCAPPED_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { entitlementsFromRow, findSubscription, recordCheckout } from '@xecret/db/repositories';
import { createLogger } from '../logging';
import type { LogEntry, RequestLog } from '../logging';
import type { MailMessage } from '../mail';

/**
 * `POST /api/billing/webhook`, end to end, against a real database — the
 * route, the wrapper, the claim, the snapshot logic and the repositories all
 * real. Stubbed: the Worker context (so the route gets PGlite), the audit sink
 * (captured), the logger (captured) and the mail provider (captured).
 *
 * **No request here ever reaches Dodo.** Every delivery is a fixture payload,
 * signed in the test with the Standard Webhooks library and a fixture secret,
 * exactly as Dodo signs one. What is asserted, for every money-moving path:
 * the status, the row afterwards, the audit trail, and that nothing changed on
 * the paths that must change nothing.
 */

const ORIGIN = 'https://xecret.playxoft.com';
/** Names itself as a fixture (`.gitleaks.toml`); base64 after the prefix, as Dodo's are. */
const SECRET = `whsec_${btoa('example-not-a-real-key-32-bytes!')}`;
const OTHER_SECRET = `whsec_${btoa('example-not-a-real-key-other-one')}`;

const PRODUCTS = {
  proMonthly: 'pdt_pro_m',
  proYearly: 'pdt_pro_y',
  teamMonthly: 'pdt_team_m',
  teamYearly: 'pdt_team_y',
};

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const mail = vi.hoisted(() => ({ sent: [] as MailMessage[] }));

vi.mock('../context', () => context);
vi.mock('../audit-sink', () => ({
  DatabaseAuditSink: class {
    write = auditSink.write;
  },
}));
vi.mock('../logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logging')>()),
  createRequestLog: logging.createRequestLog,
}));
vi.mock('../mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail')>()),
  mailerFrom: () => ({ send: async (message: MailMessage) => void mail.sent.push(message) }),
}));
// The seat sync an activation triggers talks to Dodo; here it talks to this.
const dodo = vi.hoisted(() => ({ changePlan: vi.fn(async () => undefined) }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: () => dodo,
}));

const route = await import('@/app/api/billing/webhook/route');

let t: TestDatabase;
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];
let env: Record<string, unknown> = {};

const BILLING_ENV = {
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: SECRET,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: PRODUCTS.proMonthly,
  DODO_PRODUCT_PRO_YEARLY: PRODUCTS.proYearly,
  DODO_PRODUCT_TEAM_MONTHLY: PRODUCTS.teamMonthly,
  DODO_PRODUCT_TEAM_YEARLY: PRODUCTS.teamYearly,
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
  DODO_ADDON_SAML: 'adn_saml',
};

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  deferred = [];
  mail.sent = [];
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
        ipAddress: '35.0.0.1',
        userAgent: 'Svix-Webhooks/1.0',
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
  auditSink.write.mockResolvedValue(undefined);
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const uniq = () => randomUUID().replaceAll('-', '').slice(0, 16);

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, `o-${uniq()}@example.com`],
  );
  return id;
}

/**
 * An organisation with `members` seated members, the first its owner — three
 * by default, Team's minimum, so a snapshot billing three seats is already
 * what the seat sync would push.
 */
async function seedOrg(members = 3): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  for (let index = 1; index < members; index += 1) {
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'developer')`,
      [randomUUID(), orgId, await seedUser()],
    );
  }
  // The checkout an owner started, whose nonce a subscription's metadata carries.
  await openCheckout(orgId, ownerId);
  return { orgId, ownerId };
}

/** The latest open checkout's nonce, per organisation — what our checkout put in the metadata. */
const nonces = new Map<string, string>();

async function openCheckout(
  orgId: string,
  ownerId: string | null = null,
  sessionId = `cks_${uniq()}`,
): Promise<{ nonce: string; sessionId: string }> {
  const nonce = `nonce${uniq()}${uniq()}`;
  await recordCheckout(t.db, {
    sessionId,
    orgId,
    plan: 'team',
    billingInterval: 'monthly',
    quantity: 3,
    createdBy: ownerId,
    nonce,
  });
  nonces.set(orgId, nonce);
  return { nonce, sessionId };
}

interface SubscriptionFixture {
  subscriptionId: string;
  customerId: string;
  orgId: string | null;
  /** The checkout nonce in the metadata: the org's open checkout's by default; `null` for none. */
  nonce?: string | null;
  status?: string;
  product?: string;
  quantity?: number;
  currency?: string;
  country?: string;
  cancelAtNext?: boolean;
  trialDays?: number;
  createdAt?: Date;
  periodStart?: Date;
  periodEnd?: Date;
  addons?: { addon_id: string; quantity: number }[];
}

const DAY = 24 * 60 * 60 * 1000;

function subscriptionData(fixture: SubscriptionFixture) {
  const now = Date.now();
  return {
    subscription_id: fixture.subscriptionId,
    status: fixture.status ?? 'active',
    product_id: fixture.product ?? PRODUCTS.teamMonthly,
    quantity: fixture.quantity ?? 3,
    currency: fixture.currency ?? 'USD',
    customer: {
      customer_id: fixture.customerId,
      email: 'owner@example.com',
      name: 'Owner Person',
    },
    billing: { country: fixture.country ?? 'US', city: 'Springfield', street: '742 Evergreen' },
    metadata:
      fixture.orgId === null
        ? {}
        : {
            xecret_org_id: fixture.orgId,
            ...(fixture.nonce === null
              ? {}
              : { xecret_checkout: fixture.nonce ?? nonces.get(fixture.orgId) ?? 'none' }),
          },
    next_billing_date: (fixture.periodEnd ?? new Date(now + 30 * DAY)).toISOString(),
    previous_billing_date: (fixture.periodStart ?? new Date(now - DAY)).toISOString(),
    cancel_at_next_billing_date: fixture.cancelAtNext ?? false,
    trial_period_days: fixture.trialDays ?? 0,
    created_at: (fixture.createdAt ?? new Date(now - DAY)).toISOString(),
    recurring_pre_tax_amount: 5700,
    addons: fixture.addons ?? [],
    brand_id: 'brd_1',
    has_payment_method: true,
    tax_inclusive: false,
  };
}

interface Delivery {
  type: string;
  data: unknown;
  /** The provider's event time. */
  at?: Date;
  id?: string;
  /** The signing time, which the replay window is measured from. */
  signedAt?: Date;
  secret?: string;
}

function signedRequest(delivery: Delivery, tamper?: (body: string) => string): Request {
  const id = delivery.id ?? `msg_${uniq()}`;
  const body = JSON.stringify({
    business_id: 'bus_1',
    type: delivery.type,
    timestamp: (delivery.at ?? new Date()).toISOString(),
    data: delivery.data,
  });
  const signedAt = delivery.signedAt ?? new Date();
  const signature = new Webhook(delivery.secret ?? SECRET).sign(id, signedAt, body);
  return new Request(`${ORIGIN}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
      'webhook-signature': signature,
    },
    body: tamper ? tamper(body) : body,
  });
}

async function deliver(
  delivery: Delivery,
  tamper?: (body: string) => string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.POST(signedRequest(delivery, tamper));
  await Promise.allSettled(deferred);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function rowOf(orgId: string) {
  const row = await findSubscription(t.db, orgId);
  if (!row) throw new Error('no subscription row');
  return row;
}

async function seatLimitOf(orgId: string): Promise<number> {
  const result = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!.seat_limit;
}

async function claims(webhookId: string): Promise<number> {
  const result = await t.pg.query(`select 1 from billing_webhook_events where webhook_id = $1`, [
    webhookId,
  ]);
  return result.rows.length;
}

async function auditOf(
  orgId: string,
): Promise<{ action: string; metadata: Record<string, unknown>; actor_type: string }[]> {
  const result = await t.pg.query<{
    action: string;
    metadata: Record<string, unknown>;
    actor_type: string;
  }>(`select action, metadata, actor_type from audit_logs where org_id = $1 order by id`, [orgId]);
  return result.rows;
}

/** An active Team subscription for a fresh organisation, applied. */
async function activeTeam(
  over: Partial<SubscriptionFixture> = {},
): Promise<{ orgId: string; subscriptionId: string; customerId: string }> {
  // As many members as the checkout billed, so the seat sync the activation
  // triggers finds the bill already right.
  const { orgId } = await seedOrg(over.quantity ?? 3);
  const subscriptionId = `sub_${uniq()}`;
  const customerId = over.customerId ?? `cus_${uniq()}`;
  const answer = await deliver({
    type: 'subscription.active',
    data: subscriptionData({ subscriptionId, customerId, orgId, ...over }),
    at: new Date(Date.now() - 60_000),
  });
  expect(answer.status).toBe(200);
  return { orgId, subscriptionId, customerId };
}

/* ── the signature, the replay window, the headers ────────────────────────── */

describe('who may call it', () => {
  it('refuses a delivery signed with any other secret, and writes nothing', async () => {
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const answer = await deliver({
      id,
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
      secret: OTHER_SECRET,
    });

    expect(answer.status).toBe(401);
    expect(await claims(id)).toBe(0);
    expect((await rowOf(orgId)).plan).toBe('free');
    expect(await auditOf(orgId)).toEqual([]);
  });

  it('refuses a body changed after signing — "free" turned into "team" by somebody in between', async () => {
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const answer = await deliver(
      {
        id,
        type: 'subscription.active',
        data: subscriptionData({
          subscriptionId: `sub_${uniq()}`,
          customerId: `cus_${uniq()}`,
          orgId,
          quantity: 3,
        }),
      },
      (body) => body.replace('"quantity":3', '"quantity":300'),
    );
    expect(answer.status).toBe(401);
    expect(await claims(id)).toBe(0);
    expect((await rowOf(orgId)).plan).toBe('free');
  });

  it('refuses a replayed delivery from outside the five-minute window, however good its signature', async () => {
    const { orgId } = await seedOrg();
    const old = new Date(Date.now() - 6 * 60_000);
    const answer = await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
      signedAt: old,
      at: old,
    });
    expect(answer.status).toBe(401);
    expect((await rowOf(orgId)).plan).toBe('free');

    const future = await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
      signedAt: new Date(Date.now() + 6 * 60_000),
    });
    expect(future.status).toBe(401);
    expect((await rowOf(orgId)).plan).toBe('free');
  });

  it('refuses a delivery with no signature headers, or a webhook id that is not one', async () => {
    const bare = await route.POST(
      new Request(`${ORIGIN}/api/billing/webhook`, { method: 'POST', body: '{}' }),
    );
    expect(bare.status).toBe(401);

    const request = signedRequest({ type: 'payment.succeeded', data: {} });
    const headers = new Headers(request.headers);
    headers.set('webhook-id', "msg'; drop table org_subscriptions;--");
    const odd = await route.POST(
      new Request(request.url, { method: 'POST', headers, body: await request.text() }),
    );
    expect(odd.status).toBe(401);
  });

  it('accepts a delivery signed during a secret rotation, by either secret', async () => {
    // Dodo sends one signature per active secret while a rotation is under way.
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const data = subscriptionData({
      subscriptionId: `sub_${uniq()}`,
      customerId: `cus_${uniq()}`,
      orgId,
    });
    const body = JSON.stringify({
      type: 'subscription.active',
      timestamp: new Date().toISOString(),
      data,
    });
    const at = new Date();
    const signatures = [
      new Webhook(OTHER_SECRET).sign(id, at, body),
      new Webhook(SECRET).sign(id, at, body),
    ].join(' ');
    const response = await route.POST(
      new Request(`${ORIGIN}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'webhook-id': id,
          'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
          'webhook-signature': signatures,
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect((await rowOf(orgId)).plan).toBe('team');
  });

  it('answers 503 on a deployment with payments switched off — and on a half-configured one', async () => {
    env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production' };
    const off = await deliver({ type: 'payment.succeeded', data: {} });
    expect(off.status).toBe(503);

    env = { XECRET_PUBLIC_URL: ORIGIN, XECRET_ENV: 'production', DODO_API_KEY: 'x' };
    const half = await deliver({ type: 'payment.succeeded', data: {} });
    expect(half.status).toBe(503);
    expect(
      lines.some((line) => line.level === 'error' && /DODO_WEBHOOK_SECRET/.test(line.message)),
    ).toBe(true);
  });
});

/* ── idempotency and ordering ─────────────────────────────────────────────── */

describe('a delivery applies at most once', () => {
  it('delivered three times, changes state once', async () => {
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const delivery = {
      id,
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await deliver(delivery)).status).toBe(200);
    }

    expect(await claims(id)).toBe(1);
    const changes = (await auditOf(orgId)).filter((row) => row.action === 'plan.changed');
    expect(changes).toHaveLength(1);
    expect((await rowOf(orgId)).plan).toBe('team');
  });

  it('delivered three times at once, still changes state once', async () => {
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const delivery = {
      id,
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
    };
    const answers = await Promise.all([deliver(delivery), deliver(delivery), deliver(delivery)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(await claims(id)).toBe(1);
    expect((await auditOf(orgId)).filter((row) => row.action === 'plan.changed')).toHaveLength(1);
  });

  // The two above would hold even without the claim — re-applying a snapshot
  // is idempotent by design. These would not: every application of a failed
  // payment or a refund writes a record and raises an alert, so only the
  // claim stops a retried delivery from writing three of each.
  it('a failed payment delivered three times is one record and one alert', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    const delivery = {
      id: `msg_${uniq()}`,
      type: 'payment.failed',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        customer: { customer_id: customerId },
        billing: { country: 'US' },
        currency: 'USD',
      },
    };
    await deliver(delivery);
    await deliver(delivery);
    await deliver(delivery);
    expect(
      (await auditOf(orgId)).filter((entry) => entry.action === 'billing.payment_failed'),
    ).toHaveLength(1);
  });

  it('a refund delivered three times raises one alert', async () => {
    const { customerId } = await activeTeam();
    const delivery = {
      id: `msg_${uniq()}`,
      type: 'refund.succeeded',
      data: {
        refund_id: `ref_${uniq()}`,
        payment_id: `pay_${uniq()}`,
        customer: { customer_id: customerId },
      },
    };
    lines = [];
    await deliver(delivery);
    await deliver(delivery);
    await deliver(delivery);
    expect(lines.filter((line) => /refunded a payment/.test(line.message))).toHaveLength(1);
  });

  it('a duplicate of a seat change sends no email at all — the seat sync that pushed it tells the owners', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({ quantity: 3 });
    mail.sent = [];
    const delivery = {
      id: `msg_${uniq()}`,
      type: 'subscription.plan_changed',
      data: subscriptionData({ subscriptionId, customerId, orgId, quantity: 4 }),
    };
    await deliver(delivery);
    await deliver(delivery);
    await deliver(delivery);
    expect(mail.sent.filter((message) => /billed for/.test(message.subject))).toEqual([]);
    expect((await rowOf(orgId)).seats).toBe(4);
  });
});

describe('deliveries out of order', () => {
  it('a renewed that arrives before its active leaves the newer state, not the older', async () => {
    const { orgId } = await seedOrg(5);
    const subscriptionId = `sub_${uniq()}`;
    const customerId = `cus_${uniq()}`;
    const renewedAt = new Date(Date.now() - 10_000);
    const activeAt = new Date(Date.now() - 50_000);
    const newPeriodEnd = new Date(Date.now() + 60 * DAY);

    const renewed = await deliver({
      type: 'subscription.renewed',
      at: renewedAt,
      data: subscriptionData({
        subscriptionId,
        customerId,
        orgId,
        quantity: 5,
        periodEnd: newPeriodEnd,
      }),
    });
    expect(renewed.status).toBe(200);

    const active = await deliver({
      type: 'subscription.active',
      at: activeAt,
      data: subscriptionData({ subscriptionId, customerId, orgId, quantity: 3 }),
    });
    expect(active.status).toBe(200);

    const row = await rowOf(orgId);
    expect(row.plan).toBe('team');
    expect(row.seats).toBe(5);
    expect(row.currentPeriodEnd?.getTime()).toBe(newPeriodEnd.getTime());
    expect(row.dodoEventAt?.getTime()).toBe(renewedAt.getTime());
  });

  it('an older plan_changed cannot undo a newer one', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    await deliver({
      type: 'subscription.plan_changed',
      at: new Date(Date.now() - 1000),
      data: subscriptionData({
        subscriptionId,
        customerId,
        orgId,
        product: PRODUCTS.teamYearly,
        quantity: 8,
      }),
    });
    await deliver({
      type: 'subscription.plan_changed',
      at: new Date(Date.now() - 30_000),
      data: subscriptionData({
        subscriptionId,
        customerId,
        orgId,
        product: PRODUCTS.proMonthly,
        quantity: 2,
      }),
    });
    const row = await rowOf(orgId);
    expect(row.plan).toBe('team');
    expect(row.billingInterval).toBe('yearly');
    expect(row.seats).toBe(8);
  });
});

/* ── the subscription lifecycle ───────────────────────────────────────────── */

describe('the subscription lifecycle', () => {
  it('activation sets the plan, the seats, the period, the currency and a twelve-month region lock', async () => {
    const before = Date.now();
    const { orgId } = await activeTeam({ quantity: 4, currency: 'INR', country: 'IN' });
    const row = await rowOf(orgId);

    expect(row).toMatchObject({
      plan: 'team',
      billingInterval: 'monthly',
      status: 'active',
      seats: 4,
      currency: 'INR',
      billingCountry: 'IN',
      dodoProductId: PRODUCTS.teamMonthly,
      cancelAtPeriodEnd: false,
    });
    const lock = row.regionLockedUntil!.getTime();
    expect(lock).toBeGreaterThan(before + 360 * DAY);
    expect(lock).toBeLessThan(before + 370 * DAY);
    // A per-seat plan never refuses an invitation for want of a seat.
    expect(await seatLimitOf(orgId)).toBe(UNCAPPED_SEAT_LIMIT);

    const [change] = (await auditOf(orgId)).filter((entry) => entry.action === 'plan.changed');
    expect(change!.actor_type).toBe('system');
    expect(change!.metadata).toMatchObject({
      plan: 'team',
      previousPlan: 'free',
      billingInterval: 'monthly',
      subscriptionStatus: 'active',
      seatCount: 4,
      currency: 'INR',
      billingEvent: 'subscription.active',
    });
    // An automated change: no operator on the record.
    expect(change!.metadata).not.toHaveProperty('operator');
  });

  it('pushes the count as it is now when the checkout’s quantity is out of date by activation', async () => {
    // Checked out with four seats; two people left before the payment landed.
    const { orgId } = await seedOrg(2);
    dodo.changePlan.mockClear();
    await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
        quantity: 4,
      }),
    });
    // Team bills from three: two members are billed as three, credited the difference.
    expect(dodo.changePlan).toHaveBeenCalledWith(
      expect.stringMatching(/^sub_/),
      expect.objectContaining({ quantity: 3, proration: 'prorated_immediately_keep_cycle' }),
    );
    expect((await rowOf(orgId)).seats).toBe(3);
  });

  it('a trial is a trial, with its end recorded', async () => {
    const { orgId } = await activeTeam({ trialDays: 14, createdAt: new Date(Date.now() - DAY) });
    const row = await rowOf(orgId);
    expect(row.status).toBe('trialing');
    expect(row.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 12 * DAY);
  });

  it('on hold changes the status only — the data plane is untouched and the owners are told builds are unaffected', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    mail.sent = [];
    await deliver({
      type: 'subscription.on_hold',
      data: subscriptionData({ subscriptionId, customerId, orgId, status: 'on_hold' }),
    });
    const row = await rowOf(orgId);
    expect(row.status).toBe('on_hold');
    expect(row.plan).toBe('team');

    const entitlements = entitlementsFromRow(row);
    expect(isDataPlaneActive(entitlements.status)).toBe(true);
    // Not even the dashboard locks: the page that fixes the card is in it.
    expect(entitlements.controlPlaneActive).toBe(true);
    expect(entitlements.features.perEnvironmentGrants).toBe(true);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toContain('Your builds are unaffected');
  });

  it('a cancellation keeps the paid period, and only flags its end', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    await deliver({
      type: 'subscription.cancelled',
      data: subscriptionData({
        subscriptionId,
        customerId,
        orgId,
        status: 'cancelled',
        periodEnd: new Date(Date.now() + 10 * DAY),
      }),
    });
    const row = await rowOf(orgId);
    expect(row).toMatchObject({ plan: 'team', status: 'active', cancelAtPeriodEnd: true });
  });

  it('expiry returns the organisation to Free and deletes nothing', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({ quantity: 6 });
    const members = await t.pg.query(`select 1 from org_members where org_id = $1`, [orgId]);

    await deliver({
      type: 'subscription.expired',
      data: subscriptionData({ subscriptionId, customerId, orgId, status: 'expired' }),
    });
    const row = await rowOf(orgId);
    expect(row).toMatchObject({
      plan: 'free',
      billingInterval: null,
      status: 'active',
      seats: 1,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
    expect(await seatLimitOf(orgId)).toBe(FREE_SEAT_LIMIT);
    const after = await t.pg.query(`select 1 from org_members where org_id = $1`, [orgId]);
    expect(after.rows).toHaveLength(members.rows.length);

    const [ended] = (await auditOf(orgId)).filter(
      (entry) => entry.action === 'plan.changed' && entry.metadata['plan'] === 'free',
    );
    expect(ended!.metadata).toMatchObject({ previousPlan: 'team', reason: 'subscription ended' });
  });

  it('a plan change moves plan and seats', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({ quantity: 3 });
    mail.sent = [];
    await deliver({
      type: 'subscription.plan_changed',
      data: subscriptionData({
        subscriptionId,
        customerId,
        orgId,
        product: PRODUCTS.teamYearly,
        quantity: 5,
      }),
    });
    const row = await rowOf(orgId);
    expect(row).toMatchObject({ plan: 'team', billingInterval: 'yearly', seats: 5 });
  });

  it('turns the SAML add-on on when the subscription carries it, and never off', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({
      addons: [{ addon_id: 'adn_saml', quantity: 1 }],
    });
    expect((await rowOf(orgId)).addonSaml).toBe(true);

    await deliver({
      type: 'subscription.updated',
      data: subscriptionData({ subscriptionId, customerId, orgId, addons: [] }),
    });
    expect((await rowOf(orgId)).addonSaml).toBe(true);
  });

  it('keeps the locked region when Dodo reports another mid-term, and raises it', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({
      currency: 'INR',
      country: 'IN',
    });
    await deliver({
      type: 'subscription.updated',
      data: subscriptionData({ subscriptionId, customerId, orgId, currency: 'USD', country: 'US' }),
    });
    const row = await rowOf(orgId);
    expect(row).toMatchObject({ currency: 'INR', billingCountry: 'IN' });
    expect((await auditOf(orgId)).some((entry) => entry.action === 'billing.region_mismatch')).toBe(
      true,
    );
    expect(lines.some((line) => line.level === 'error' && /region-locked/.test(line.message))).toBe(
      true,
    );
  });
});

describe('what is never applied', () => {
  it('a second live subscription is not applied, and a human is told', async () => {
    const { orgId } = await activeTeam({ quantity: 3 });
    const before = await rowOf(orgId);
    // A second checkout, opened in another tab before the first was paid.
    await openCheckout(orgId);
    const answer = await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
        product: PRODUCTS.proMonthly,
        quantity: 9,
      }),
    });
    expect(answer.status).toBe(200);
    const after = await rowOf(orgId);
    expect(after.dodoSubscriptionId).toBe(before.dodoSubscriptionId);
    expect(after.plan).toBe('team');
    expect(after.seats).toBe(3);
    expect(
      (await auditOf(orgId)).some((entry) => entry.action === 'billing.duplicate_subscription'),
    ).toBe(true);
    expect(lines.some((line) => line.level === 'error' && /paying twice/.test(line.message))).toBe(
      true,
    );
  });

  it('an operator’s grant is never overwritten by a webhook', async () => {
    const { orgId } = await seedOrg();
    await t.pg.query(
      `update org_subscriptions set plan = 'enterprise', billing_interval = 'yearly', seats = 25 where org_id = $1`,
      [orgId],
    );
    await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
    });
    expect(await rowOf(orgId)).toMatchObject({ plan: 'enterprise', seats: 25 });
  });

  it('a product this deployment does not sell grants nothing, and is reported as drift', async () => {
    const { orgId } = await seedOrg();
    await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
        product: 'pdt_scale_monthly',
      }),
    });
    expect((await rowOf(orgId)).plan).toBe('free');
    const drift = (await auditOf(orgId)).find((entry) => entry.action === 'billing.drift_detected');
    expect(drift?.metadata).toMatchObject({ driftFields: ['product'] });
  });

  it('an organisation named by nothing but a forged metadata id in a signed payload cannot be another tenant', async () => {
    // Metadata is ours and Dodo signs it — but a metadata id must still name a
    // live organisation, and a deleted one does not.
    const { orgId } = await seedOrg();
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);
    const answer = await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
    });
    // One of ours by product, not yet placeable: Dodo is asked to retry.
    expect(answer.status).toBe(503);
    expect((await rowOf(orgId)).plan).toBe('free');
  });
});

describe('a subscription attaches only through a checkout this server created', () => {
  it('a signed subscription naming a real organisation, with no nonce, attaches to nothing', async () => {
    const { orgId } = await seedOrg();
    const id = `msg_${uniq()}`;
    const answer = await deliver({
      id,
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
        nonce: null,
      }),
    });
    // Claimed — Dodo has nothing to retry — and attached to nothing.
    expect(answer.status).toBe(200);
    expect(await claims(id)).toBe(1);
    expect(await rowOf(orgId)).toMatchObject({ plan: 'free', dodoSubscriptionId: null });
    expect(
      lines.some((line) => line.level === 'error' && /attached to nothing/.test(line.message)),
    ).toBe(true);
  });

  it('nor with a nonce nobody minted, or another organisation’s', async () => {
    const { orgId } = await seedOrg();
    const other = await seedOrg();
    for (const nonce of [`nonce${uniq()}${uniq()}`, nonces.get(other.orgId)!]) {
      const answer = await deliver({
        type: 'subscription.active',
        data: subscriptionData({
          subscriptionId: `sub_${uniq()}`,
          customerId: `cus_${uniq()}`,
          orgId,
          nonce,
        }),
      });
      expect(answer.status).toBe(200);
      expect((await rowOf(orgId)).plan).toBe('free');
    }
    expect((await rowOf(other.orgId)).plan).toBe('free');
  });

  it('a payment naming a real organisation with no nonce links nothing', async () => {
    const { orgId } = await seedOrg();
    await deliver({
      type: 'payment.succeeded',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: `sub_${uniq()}`,
        customer: { customer_id: `cus_${uniq()}` },
        billing: { country: 'US' },
        currency: 'USD',
        metadata: { xecret_org_id: orgId },
      },
    });
    expect(await rowOf(orgId)).toMatchObject({ plan: 'free', dodoSubscriptionId: null });
  });

  it('spends the checkout: a second subscription carrying the same nonce attaches to nothing', async () => {
    const { orgId, subscriptionId } = await activeTeam();
    await deliver({
      type: 'subscription.expired',
      data: subscriptionData({
        subscriptionId,
        customerId: `cus_${uniq()}`,
        orgId,
        status: 'expired',
      }),
    });
    expect((await rowOf(orgId)).plan).toBe('free');

    // A new subscription replaying the first checkout's nonce.
    await deliver({
      type: 'subscription.active',
      data: subscriptionData({
        subscriptionId: `sub_${uniq()}`,
        customerId: `cus_${uniq()}`,
        orgId,
      }),
    });
    expect((await rowOf(orgId)).plan).toBe('free');
  });
});

describe('an operator’s grant, against a checkout payment', () => {
  it('links nothing, raises it, and the subscription that follows is still not applied', async () => {
    // The owner started a checkout; support then set the plan by hand; the
    // checkout's payment lands afterwards.
    const { orgId, ownerId } = await seedOrg();
    const { sessionId } = await openCheckout(orgId, ownerId);
    await t.pg.query(
      `update org_subscriptions set plan = 'enterprise', billing_interval = 'yearly', seats = 25 where org_id = $1`,
      [orgId],
    );
    const subscriptionId = `sub_${uniq()}`;
    const customerId = `cus_${uniq()}`;

    const payment = await deliver({
      type: 'payment.succeeded',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        checkout_session_id: sessionId,
        customer: { customer_id: customerId },
        billing: { country: 'US' },
        currency: 'USD',
      },
    });
    expect(payment.status).toBe(200);
    expect(await rowOf(orgId)).toMatchObject({
      plan: 'enterprise',
      seats: 25,
      dodoSubscriptionId: null,
      dodoCustomerId: null,
    });
    expect(
      lines.some((line) => line.level === 'error' && /operator set by hand/.test(line.message)),
    ).toBe(true);

    await deliver({
      type: 'subscription.active',
      data: subscriptionData({ subscriptionId, customerId, orgId }),
    });
    expect(await rowOf(orgId)).toMatchObject({
      plan: 'enterprise',
      seats: 25,
      dodoSubscriptionId: null,
    });
  });
});

describe('the Dodo mode', () => {
  it('records the mode a subscription was made in', async () => {
    const { orgId } = await activeTeam();
    expect((await rowOf(orgId)).dodoMode).toBe('test_mode');
  });

  it('refuses a live-mode event for a row recorded in test mode, and says so', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    env = { ...env, DODO_ENVIRONMENT: 'live_mode' };
    const answer = await deliver({
      type: 'subscription.on_hold',
      data: subscriptionData({ subscriptionId, customerId, orgId, status: 'on_hold' }),
    });
    expect(answer.status).toBe(200);
    expect((await rowOf(orgId)).status).toBe('active');
    expect(
      lines.some((line) => line.level === 'error' && /other Dodo mode/.test(line.message)),
    ).toBe(true);
  });
});

/* ── placement of a first checkout ────────────────────────────────────────── */

describe('a first checkout', () => {
  it('waits for its payment when the subscription carries no metadata, then applies', async () => {
    const { orgId, ownerId } = await seedOrg();
    const subscriptionId = `sub_${uniq()}`;
    const customerId = `cus_${uniq()}`;
    const { sessionId } = await openCheckout(orgId, ownerId);

    const active = {
      id: `msg_${uniq()}`,
      type: 'subscription.active',
      at: new Date(Date.now() - 5000),
      data: subscriptionData({ subscriptionId, customerId, orgId: null }),
    };
    // Not placeable yet: not claimed, so Dodo's retry can be.
    expect((await deliver(active)).status).toBe(503);
    expect(await claims(active.id)).toBe(0);

    const payment = await deliver({
      type: 'payment.succeeded',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        checkout_session_id: sessionId,
        customer: { customer_id: customerId, email: 'owner@example.com' },
        billing: { country: 'US' },
        card_issuing_country: 'US',
        card_last_four: '4242',
        currency: 'USD',
        total_amount: 5700,
        metadata: {},
      },
    });
    expect(payment.status).toBe(200);
    expect((await rowOf(orgId)).plan).toBe('free'); // a payment links; it grants nothing

    // Dodo's retry.
    expect((await deliver(active)).status).toBe(200);
    expect(await rowOf(orgId)).toMatchObject({ plan: 'team', dodoSubscriptionId: subscriptionId });
  });

  it('raises a billing country that is not the card’s country, and changes nothing', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam({
      country: 'IN',
      currency: 'INR',
    });
    const answer = await deliver({
      type: 'payment.succeeded',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        customer: { customer_id: customerId },
        billing: { country: 'IN' },
        card_issuing_country: 'US',
        currency: 'INR',
      },
    });
    expect(answer.status).toBe(200);
    expect((await rowOf(orgId)).plan).toBe('team');
    expect((await auditOf(orgId)).some((entry) => entry.action === 'billing.region_mismatch')).toBe(
      true,
    );
  });
});

/* ── payments, refunds, disputes, licences ───────────────────────────────── */

describe('money events that change no access', () => {
  it('a failed payment is recorded and emailed, and the plan stays', async () => {
    const { orgId, subscriptionId, customerId } = await activeTeam();
    mail.sent = [];
    await deliver({
      type: 'payment.failed',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        customer: { customer_id: customerId },
        billing: { country: 'US' },
        currency: 'USD',
      },
    });
    expect((await rowOf(orgId)).plan).toBe('team');
    expect((await auditOf(orgId)).some((entry) => entry.action === 'billing.payment_failed')).toBe(
      true,
    );
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toContain('Your builds are unaffected');
  });

  it('a refund and a dispute alert a human and leave access exactly as it was', async () => {
    const { orgId, customerId } = await activeTeam();
    const before = await rowOf(orgId);

    await deliver({
      type: 'refund.succeeded',
      data: {
        refund_id: `ref_${uniq()}`,
        payment_id: `pay_${uniq()}`,
        customer: { customer_id: customerId },
        is_partial: false,
      },
    });
    await deliver({
      type: 'dispute.opened',
      data: { dispute_id: `dsp_${uniq()}`, payment_id: `pay_${uniq()}`, amount: '5700' },
    });

    const after = await rowOf(orgId);
    expect(after.plan).toBe(before.plan);
    expect(after.status).toBe(before.status);
    expect((await auditOf(orgId)).some((entry) => entry.action === 'billing.refunded')).toBe(true);
    const alerts = lines.filter((line) => line.level === 'error').map((line) => line.message);
    expect(alerts.some((message) => /refunded a payment/.test(message))).toBe(true);
    expect(alerts.some((message) => /dispute/.test(message))).toBe(true);
  });

  it('a licence key is recorded against its order, and the key itself is kept nowhere', async () => {
    const licenseKeyId = `lic_${uniq()}`;
    const key = 'XECRET-EXAMPLE-NOT-A-REAL-KEY-LICENCE';
    const answer = await deliver({
      type: 'license_key.created',
      data: {
        id: licenseKeyId,
        key,
        product_id: 'pdt_selfhost_50',
        customer_id: `cus_${uniq()}`,
        activations_limit: 3,
        created_at: new Date().toISOString(),
        status: 'active',
        instances_count: 0,
        source: 'auto',
        business_id: 'bus_1',
        brand_id: 'brd_1',
      },
    });
    expect(answer.status).toBe(200);
    const stored = await t.pg.query(
      `select * from billing_license_keys where license_key_id = $1`,
      [licenseKeyId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(key);
    expect(JSON.stringify(lines)).not.toContain(key);
  });

  it('an event type nobody handles is claimed and answered 200, never 500', async () => {
    const id = `msg_${uniq()}`;
    const answer = await deliver({ id, type: 'payout.success', data: { payout_id: 'po_1' } });
    expect(answer.status).toBe(200);
    expect(await claims(id)).toBe(1);
  });

  it('a verified payload this server cannot read is refused 400 and not claimed', async () => {
    const id = `msg_${uniq()}`;
    const answer = await deliver({
      id,
      type: 'subscription.active',
      data: { subscription_id: 'sub_1', status: 'zombie' },
    });
    expect(answer.status).toBe(400);
    expect(await claims(id)).toBe(0);
  });
});

/* ── redaction ────────────────────────────────────────────────────────────── */

describe('what never reaches a log line or an audit row', () => {
  it('no customer id, webhook secret, API key, card detail or address', async () => {
    const customerId = `cus_${uniq()}`;
    const { orgId, subscriptionId } = await activeTeam({ customerId });
    await deliver({
      type: 'payment.succeeded',
      data: {
        payment_id: `pay_${uniq()}`,
        subscription_id: subscriptionId,
        customer: { customer_id: customerId, email: 'owner@example.com' },
        billing: { country: 'US', street: '742 Evergreen' },
        card_issuing_country: 'GB',
        card_last_four: '4242',
        currency: 'USD',
      },
    });
    const audit = JSON.stringify(await auditOf(orgId));
    const written = (auditSink.write.mock.calls as unknown as AuditRecord[][][])
      .flat(2)
      .map((record) => JSON.stringify(record))
      .join('\n');
    const logged = JSON.stringify(lines);

    for (const surface of [audit, written, logged]) {
      expect(surface).not.toContain(SECRET);
      expect(surface).not.toContain(BILLING_ENV.DODO_API_KEY);
      expect(surface).not.toContain('4242');
      expect(surface).not.toContain('Evergreen');
      expect(surface).not.toContain('owner@example.com');
      expect(surface).not.toMatch(/cus_[A-Za-z0-9]{8,}/);
    }
  });
});
