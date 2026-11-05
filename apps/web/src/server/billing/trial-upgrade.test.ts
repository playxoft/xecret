import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { addFetchCounts, findSubscription } from '@xecret/db/repositories';
import type { Principal } from '../actor';
import type { ServiceContext } from '../context';
import { createLogger } from '../logging';
import type { LogEntry, RequestLog } from '../logging';
import type { MailMessage } from '../mail';
import type { BillingProvider, CheckoutRequest, UsageEvent } from './client';
import type { DodoSubscription } from './payloads';

/**
 * An upgrade during a trial, replayed end to end — the staging rehearsal of
 * 2026-11-05 whose hard-gate check failed (docs/operations/billing.md §3).
 *
 * What happened there: a Team monthly checkout on the 14-day trial (a card
 * mandate, nothing charged); the owner moved to Team yearly; Dodo tried the
 * prorated charge at once and it was declined; Dodo kept the subscription as
 * it was — monthly, on trial, its next charge still the trial's booked end —
 * and moved only its `previous_billing_date`, to the attempt. The row read
 * that as a payment and ended the trial: active, metered from the attempt,
 * no more trial emails.
 *
 * Here, every step goes through the code that ran it there: the checkout and
 * change routes, the signed webhook, the hourly job (the reminders and the
 * meter) and the nightly reconciler — against a real database, with Dodo
 * stubbed at `billingProvider` and the mail provider captured. Nothing here
 * reaches either.
 */

const ORIGIN = 'https://xecret-staging.playxoft.com';
const SECRET = `whsec_${btoa('example-not-a-real-key-32-bytes!')}`;
const DAY = 24 * 60 * 60 * 1000;

const context = vi.hoisted(() => ({ workerContext: vi.fn(), createServiceContext: vi.fn() }));
const actor = vi.hoisted(() => ({
  authenticate: vi.fn(),
  assertCsrf: vi.fn(),
  isUnlocked: vi.fn(() => true),
}));
const auditSink = vi.hoisted(() => ({ write: vi.fn() }));
const logging = vi.hoisted(() => ({ createRequestLog: vi.fn() }));
const mail = vi.hoisted(() => ({ sent: [] as MailMessage[] }));
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
vi.mock('../mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail')>()),
  mailerFrom: () => ({ send: async (message: MailMessage) => void mail.sent.push(message) }),
}));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: (): BillingProvider => dodo as unknown as BillingProvider,
}));

const statusRoute = await import('@/app/api/orgs/[orgSlug]/billing/route');
const checkoutRoute = await import('@/app/api/orgs/[orgSlug]/billing/checkout/route');
const changeRoute = await import('@/app/api/orgs/[orgSlug]/billing/change/route');
const webhookRoute = await import('@/app/api/billing/webhook/route');
const { runHourlyBillingJob, TRIAL_GRACE_MS } = await import('./jobs');
const { reconcileSubscriptions } = await import('./reconcile');
const { DodoApiError } = await import('./client');

let t: TestDatabase;
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];
let caller: Principal;

const env: Record<string, unknown> = {
  XECRET_PUBLIC_URL: ORIGIN,
  XECRET_ENV: 'production',
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: SECRET,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};

/** What Dodo holds, per subscription — what `getSubscription` answers the jobs with. */
const dodoHas = new Map<string, DodoSubscription>();

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
  deferred = [];
  mail.sent = [];

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
  actor.authenticate.mockImplementation(async () => ({ principal: caller, source: 'cookie' }));
  actor.assertCsrf.mockReturnValue(undefined);
  actor.isUnlocked.mockReturnValue(true);
  auditSink.write.mockResolvedValue(undefined);

  dodo.changePlan.mockResolvedValue(undefined);
  dodo.ingestUsage.mockResolvedValue(undefined);
  dodo.cardExpiries.mockResolvedValue(new Map());
  dodo.getSubscription.mockImplementation(async (id: string) => {
    const held = dodoHas.get(id);
    if (held === undefined) throw new DodoApiError('not_found', 404);
    return held;
  });
});

afterEach(() => {
  vi.useRealTimers();
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

/** A Free organisation of three — the owner and two developers — as the rehearsal's was. */
async function seedOrg(): Promise<{ orgId: string; slug: string; ownerEmail: string }> {
  const owner = await seedUser();
  const orgId = randomUUID();
  const slug = `acme-${orgId.slice(0, 8)}`;
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, slug, owner.id],
  );
  await t.pg.query(`insert into org_subscriptions (org_id) values ($1)`, [orgId]);
  for (const [userId, role] of [
    [owner.id, 'owner'],
    [(await seedUser()).id, 'developer'],
    [(await seedUser()).id, 'developer'],
  ] as const) {
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), orgId, userId, role],
    );
  }
  caller = {
    kind: 'user',
    sessionId: randomUUID(),
    user: {
      id: owner.id,
      email: owner.email,
      emailVerified: true,
      displayName: 'Owner',
      avatarUrl: null,
    },
    vaultUnlockedAt: new Date(),
    lastSeenAt: new Date(),
    vaultAutoLockMinutes: null,
    signIn: { method: 'password', ssoWorkosOrgId: null },
  };
  return { orgId, slug, ownerEmail: owner.email };
}

function services(): ServiceContext {
  return {
    env: env as never,
    db: t.db,
    log: createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
    }).logger,
    meta: {
      requestId: randomUUID(),
      rayId: null,
      ipAddress: null,
      userAgent: null,
      method: 'POST',
      path: '/',
      startedAt: Date.now(),
    },
    waitUntil: () => {},
  } as unknown as ServiceContext;
}

async function call(
  handler: (
    request: Request,
    args?: { params?: Promise<{ orgSlug: string }> },
  ) => Promise<Response>,
  method: string,
  slug: string,
  path = '',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${ORIGIN}/api/orgs/${slug}/billing${path}`, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
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

/** One signed delivery, as Dodo sends it. */
async function deliver(type: string, data: unknown): Promise<number> {
  const id = `msg_${randomUUID().replaceAll('-', '')}`;
  const at = new Date();
  const body = JSON.stringify({ business_id: 'bus_1', type, timestamp: at.toISOString(), data });
  const response = await webhookRoute.POST(
    new Request(`${ORIGIN}/api/billing/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
        'webhook-signature': new Webhook(SECRET).sign(id, at, body),
      },
      body,
    }),
  );
  await Promise.allSettled(deferred);
  return response.status;
}

async function rowOf(orgId: string) {
  const row = await findSubscription(t.db, orgId);
  if (row === null) throw new Error('no subscription row');
  return row;
}

async function auditActions(orgId: string): Promise<{ action: string; driftFields: unknown }[]> {
  const result = await t.pg.query<{ action: string; metadata: Record<string, unknown> }>(
    `select action, metadata from audit_logs where org_id = $1 order by id`,
    [orgId],
  );
  return result.rows.map((row) => ({
    action: row.action,
    driftFields: row.metadata['driftFields'],
  }));
}

/** The subjects of the emails an organisation's owner was sent. */
function subjectsFor(trial: { ownerEmail: string }): string[] {
  return mail.sent
    .filter((message) => message.to === trial.ownerEmail)
    .map((message) => message.subject);
}

/** The meter events reported for an organisation, by the event ids it was sent. */
function reportedFor(orgId: string): string[] {
  return dodo.ingestUsage.mock.calls.flatMap(([events]) =>
    (events as UsageEvent[]).map((event) => event.eventId).filter((id) => id.startsWith(orgId)),
  );
}

interface Trial {
  orgId: string;
  slug: string;
  ownerEmail: string;
  subscriptionId: string;
  created: Date;
  bookedEnd: Date;
  /** Dodo's subscription as it stands, to send again with changes. */
  dodoSays: (over?: Partial<DodoSubscription>) => DodoSubscription;
}

/**
 * Steps 1 and 2: the owner checks out Team monthly; Dodo starts the 14-day
 * trial on a card mandate — nothing charged, the next charge the trial's end.
 */
async function startTrial(): Promise<Trial> {
  const { orgId, slug, ownerEmail } = await seedOrg();
  const sessionId = `cks_${randomUUID().slice(0, 12)}`;
  dodo.createCheckoutSession.mockResolvedValue({
    sessionId,
    url: `https://test.checkout.dodopayments.com/session/${sessionId}`,
  });
  const checkout = await call(checkoutRoute.POST, 'POST', slug, '/checkout', {
    plan: 'team',
    interval: 'monthly',
  });
  expect(checkout.status).toBe(200);
  const request = dodo.createCheckoutSession.mock.calls[0]![0] as CheckoutRequest;
  expect(request).toMatchObject({ productId: 'pdt_team_m', quantity: 3 });

  const subscriptionId = `sub_${randomUUID().replaceAll('-', '').slice(0, 17)}`;
  // The checkout was paid a few minutes ago.
  const created = new Date(Date.now() - 5 * 60_000);
  const bookedEnd = new Date(created.getTime() + 14 * DAY);
  const base: DodoSubscription = {
    subscription_id: subscriptionId,
    status: 'active',
    product_id: 'pdt_team_m',
    quantity: 3,
    currency: 'INR',
    customer: { customer_id: `cus_${randomUUID().replaceAll('-', '').slice(0, 12)}` },
    billing: { country: 'IN' },
    // What our checkout put on it, which Dodo copies onto the subscription.
    metadata: { xecret_org_id: orgId, xecret_checkout: request.nonce },
    next_billing_date: bookedEnd.toISOString(),
    previous_billing_date: created.toISOString(),
    cancel_at_next_billing_date: false,
    trial_period_days: 14,
    created_at: created.toISOString(),
    recurring_pre_tax_amount: 159_300,
    addons: [],
    scheduled_change: null,
  };
  const dodoSays = (over: Partial<DodoSubscription> = {}): DodoSubscription => {
    const now = { ...base, ...over };
    dodoHas.set(subscriptionId, now);
    return now;
  };

  expect(await deliver('subscription.active', dodoSays())).toBe(200);
  expect(await rowOf(orgId)).toMatchObject({
    plan: 'team',
    billingInterval: 'monthly',
    status: 'trialing',
    trialEndsAt: bookedEnd,
    meteredFrom: bookedEnd,
  });
  return { orgId, slug, ownerEmail, subscriptionId, created, bookedEnd, dodoSays };
}

/**
 * Step 3: the owner moves to Team yearly from the billing screen — which sends
 * an idempotency key with every decision — and Dodo accepts the request and
 * tries the charge.
 */
async function moveToYearly(trial: Trial): Promise<void> {
  const answer = await call(
    changeRoute.POST,
    'POST',
    trial.slug,
    '/change',
    { plan: 'team', interval: 'yearly' },
    { 'idempotency-key': randomUUID() },
  );
  expect(answer).toEqual({ status: 200, body: { requested: true, effective: 'now' } });
  expect(dodo.changePlan).toHaveBeenCalledWith(trial.subscriptionId, {
    productId: 'pdt_team_y',
    quantity: 3,
    proration: 'prorated_immediately',
    effectiveAt: 'immediately',
    onPaymentFailure: 'prevent_change',
  });
  // The request grants nothing: the row is as it was until Dodo says otherwise.
  expect(await rowOf(trial.orgId)).toMatchObject({
    billingInterval: 'monthly',
    status: 'trialing',
  });
}

function payment(trial: Trial) {
  return {
    payment_id: `pay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    subscription_id: trial.subscriptionId,
    customer: { customer_id: dodoHas.get(trial.subscriptionId)!.customer.customer_id },
    billing: { country: 'IN' },
    currency: 'INR',
  };
}

/* ── the rehearsal ────────────────────────────────────────────────────────── */

describe('an upgrade during a trial — the staging rehearsal of 2026-11-05, replayed', () => {
  it('declined: the trial goes on as booked — trialing, its end, its emails, nothing metered, no drift', async () => {
    const trial = await startTrial();
    await moveToYearly(trial);

    // Step 4: the charge (₹15,926.46) is declined. Dodo sends payment.failed
    // and a snapshot of what it kept — monthly, on trial, the next charge
    // still the booked end — with only the "last payment" moved, to the attempt.
    mail.sent = [];
    const attempted = new Date();
    expect(await deliver('payment.failed', payment(trial))).toBe(200);
    expect(
      await deliver(
        'subscription.updated',
        trial.dodoSays({ previous_billing_date: attempted.toISOString() }),
      ),
    ).toBe(200);

    // The row: still the trial, from its start to its booked end — nothing of
    // the change half-applied.
    const row = await rowOf(trial.orgId);
    expect(row).toMatchObject({
      plan: 'team',
      billingInterval: 'monthly',
      dodoProductId: 'pdt_team_m',
      status: 'trialing',
      seats: 3,
      trialEndsAt: trial.bookedEnd,
      meteredFrom: trial.bookedEnd,
      currentPeriodStart: trial.created,
      currentPeriodEnd: trial.bookedEnd,
      dodoScheduledChangeAt: null,
      onHoldSince: null,
    });
    const owed = await t.pg.query(`select 1 from billing_seat_syncs where org_id = $1`, [
      trial.orgId,
    ]);
    expect(owed.rows).toHaveLength(0);
    // Nothing material changed after the activation: one plan.changed, its own.
    expect(
      (await auditActions(trial.orgId)).filter((entry) => entry.action === 'plan.changed'),
    ).toHaveLength(1);

    // The billing screen says Trial, ending when it was booked to.
    const screen = await call(statusRoute.GET, 'GET', trial.slug);
    expect(screen.body['billing']).toMatchObject({
      plan: 'team',
      interval: 'monthly',
      status: 'trialing',
      trialEndsAt: trial.bookedEnd.toISOString(),
      renewsAt: trial.bookedEnd.toISOString(),
    });

    // The owners were told the card was declined — and, the upgrade having
    // just been asked for, that the trial goes on.
    expect(subjectsFor(trial)).toEqual(["A payment for Acme didn't go through"]);
    const declined = mail.sent.find((message) => message.to === trial.ownerEmail)!;
    expect(declined.text).toContain('the trial still ends on');
    expect(declined.text).not.toMatch(/on hold/);

    // Fetches made after the change: counted, never metered — it is a trial.
    await addFetchCounts(t.db, [{ orgId: trial.orgId, fetches: 5_000_000 }]);

    // Three days before the booked end, the trial email still comes, and the
    // hourly meter reports nothing for the trial.
    mail.sent = [];
    await runHourlyBillingJob(services(), new Date(trial.bookedEnd.getTime() - 2 * DAY));
    expect(subjectsFor(trial)).toContain('Your Team trial for Acme ends in 3 days');
    expect(reportedFor(trial.orgId)).toEqual([]);

    // The nightly reconciler, asking Dodo for what it kept: nothing disagrees.
    await reconcileSubscriptions(services());
    expect(dodo.getSubscription).toHaveBeenCalledWith(trial.subscriptionId);
    expect(
      (await auditActions(trial.orgId)).filter(
        (entry) => entry.action === 'billing.drift_detected',
      ),
    ).toEqual([]);
  });

  it('paid: the trial ends at the payment — active, yearly, metered from it, no drift', async () => {
    const trial = await startTrial();
    await moveToYearly(trial);

    // The charge goes through: a paid year begins, and Dodo's next charge is a
    // year out. Whether or not Dodo still reports the trial's length.
    const paid = new Date();
    expect(await deliver('payment.succeeded', payment(trial))).toBe(200);
    expect(
      await deliver(
        'subscription.plan_changed',
        trial.dodoSays({
          product_id: 'pdt_team_y',
          trial_period_days: 0,
          previous_billing_date: paid.toISOString(),
          next_billing_date: new Date(paid.getTime() + 365 * DAY).toISOString(),
          recurring_pre_tax_amount: 1_207_500,
        }),
      ),
    ).toBe(200);

    expect(await rowOf(trial.orgId)).toMatchObject({
      plan: 'team',
      billingInterval: 'yearly',
      dodoProductId: 'pdt_team_y',
      status: 'active',
      trialEndsAt: paid,
      meteredFrom: paid,
      currentPeriodStart: paid,
    });
    expect((await call(statusRoute.GET, 'GET', trial.slug)).body['billing']).toMatchObject({
      interval: 'yearly',
      status: 'active',
    });

    // Metered from the payment: the year's first month, past Team's million.
    await addFetchCounts(t.db, [{ orgId: trial.orgId, fetches: 1_005_000 }]);
    mail.sent = [];
    await runHourlyBillingJob(services(), new Date(trial.bookedEnd.getTime() - 2 * DAY));
    expect(reportedFor(trial.orgId)).toEqual(
      [0, 1, 2, 3, 4].map((unit) => `${trial.orgId}:${paid.toISOString()}:${unit}`),
    );
    // And no trial email: the trial is over.
    expect(subjectsFor(trial)).not.toContain('Your Team trial for Acme ends in 3 days');

    await reconcileSubscriptions(services());
    expect(
      (await auditActions(trial.orgId)).filter(
        (entry) => entry.action === 'billing.drift_detected',
      ),
    ).toEqual([]);
  });

  it('untouched: the trial reaches its booked end and converts as it always did', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const trial = await startTrial();

    // The booked end passes and Dodo has not charged yet: its next charge is
    // still the booked end. The hourly job asks, and the row reads the trial
    // as over by the clock — no trial email, nothing metered from before it.
    const lapsed = new Date(trial.bookedEnd.getTime() + TRIAL_GRACE_MS + 60_000);
    vi.setSystemTime(lapsed);
    await runHourlyBillingJob(services(), lapsed);
    expect(await rowOf(trial.orgId)).toMatchObject({
      status: 'active',
      trialEndsAt: trial.bookedEnd,
      meteredFrom: trial.bookedEnd,
    });

    // Then Dodo charges the card for the first month: the renewal payment,
    // and the snapshot of the paid period it began — its next charge a month
    // past the booked end.
    const charged = new Date(lapsed.getTime() + 10 * 60_000);
    vi.setSystemTime(charged);
    const nextCharge = new Date(trial.bookedEnd.getTime() + 30 * DAY);
    expect(await deliver('payment.succeeded', payment(trial))).toBe(200);
    expect(
      await deliver(
        'subscription.renewed',
        trial.dodoSays({
          previous_billing_date: charged.toISOString(),
          next_billing_date: nextCharge.toISOString(),
        }),
      ),
    ).toBe(200);
    expect(await rowOf(trial.orgId)).toMatchObject({
      plan: 'team',
      billingInterval: 'monthly',
      status: 'active',
      trialEndsAt: trial.bookedEnd,
      meteredFrom: trial.bookedEnd,
      currentPeriodStart: charged,
      currentPeriodEnd: nextCharge,
    });

    await reconcileSubscriptions(services());
    expect(
      (await auditActions(trial.orgId)).filter(
        (entry) => entry.action === 'billing.drift_detected',
      ),
    ).toEqual([]);
  });
});
