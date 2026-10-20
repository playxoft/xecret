import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { findSubscription } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { createLogger } from '../logging';
import type { LogEntry } from '../logging';
import type { MailMessage } from '../mail';
import type { DodoSubscription } from './payloads';

/**
 * The hourly billing job and the nightly reconciler, against a real database,
 * with Dodo and the mail provider stubbed — nothing here reaches either.
 */

const dodo = vi.hoisted(() => ({
  changePlan: vi.fn(),
  ingestUsage: vi.fn(),
  getSubscription: vi.fn(),
  cardExpiries: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sent: [] as MailMessage[] }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: () => dodo,
}));
vi.mock('../mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mail')>()),
  mailerFrom: () => ({ send: async (message: MailMessage) => void mail.sent.push(message) }),
}));

const { runHourlyBillingJob, CANCELLATION_GRACE_MS, CARD_CHECK_HOUR_UTC } = await import('./jobs');
const { reconcileSubscriptions, driftBetween } = await import('./reconcile');
const { DodoApiError } = await import('./client');
const { billingSetup } = await import('./config');
const {
  jobsFor,
  BILLING_DAILY_PATH,
  BILLING_HOURLY_PATH,
  VAULT_PURGE_PATH,
  DAILY_CRON,
  HOURLY_CRON,
} = await import('../scheduled');

let t: TestDatabase;
let lines: LogEntry[] = [];

const BILLING_ENV = {
  XECRET_ENV: 'production',
  XECRET_PUBLIC_URL: 'https://xecret.playxoft.com',
  DODO_API_KEY: 'dodo-example-not-a-real-key',
  DODO_WEBHOOK_SECRET: `whsec_${btoa('example-not-a-real-key-32-bytes!')}`,
  DODO_ENVIRONMENT: 'test_mode',
  DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m',
  DODO_PRODUCT_PRO_YEARLY: 'pdt_pro_y',
  DODO_PRODUCT_TEAM_MONTHLY: 'pdt_team_m',
  DODO_PRODUCT_TEAM_YEARLY: 'pdt_team_y',
  DODO_METER_SECRET_FETCH: 'secret_fetch_kilo',
};

function services(env: Record<string, unknown> = BILLING_ENV): ServiceContext {
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

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  for (const fn of Object.values(dodo)) fn.mockReset();
  dodo.changePlan.mockResolvedValue(undefined);
  dodo.ingestUsage.mockResolvedValue(undefined);
  dodo.cardExpiries.mockResolvedValue(new Map());
  mail.sent = [];
  lines = [];
});

const DAY = 86_400_000;
/**
 * The real clock — the sweeps compare with the database's `now()` — moved an
 * hour on if it happens to be the card-check hour, so tests that are not about
 * cards make no card calls.
 */
const NOW = (() => {
  const real = new Date();
  return real.getUTCHours() === CARD_CHECK_HOUR_UTC ? new Date(real.getTime() + 3_600_000) : real;
})();

async function seedOrg(subscription: Record<string, unknown>, members = 3): Promise<string> {
  const ownerId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [
      ownerId,
      `user_01${ownerId.replaceAll('-', '').slice(0, 20)}`,
      `o-${ownerId.slice(0, 8)}@example.com`,
    ],
  );
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId],
  );
  const row = {
    plan: 'team',
    billing_interval: 'monthly',
    status: 'active',
    seats: members,
    dodo_customer_id: `cus_${orgId.slice(0, 12).replaceAll('-', '')}`,
    dodo_subscription_id: `sub_${orgId.slice(0, 12).replaceAll('-', '')}`,
    dodo_product_id: 'pdt_team_m',
    current_period_start: new Date(NOW.getTime() - 5 * DAY),
    current_period_end: new Date(NOW.getTime() + 25 * DAY),
    ...subscription,
  };
  const columns = ['org_id', ...Object.keys(row)];
  await t.pg.query(
    `insert into org_subscriptions (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    [orgId, ...Object.values(row)],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  for (let index = 1; index < members; index += 1) {
    const id = randomUUID();
    await t.pg.query(
      `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
      [id, `user_01${id.replaceAll('-', '').slice(0, 20)}`, `m-${id.slice(0, 8)}@example.com`],
    );
    await t.pg.query(
      `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'developer')`,
      [randomUUID(), orgId, id],
    );
  }
  return orgId;
}

const subjects = () => mail.sent.map((message) => message.subject);

describe('the schedule', () => {
  it('runs the reconciler nightly, and the purge then billing hourly', () => {
    expect(jobsFor(DAILY_CRON)).toEqual([BILLING_DAILY_PATH]);
    expect(jobsFor(HOURLY_CRON)).toEqual([VAULT_PURGE_PATH, BILLING_HOURLY_PATH]);
  });

  it('answers the internet 404 on both billing job routes, before building anything', async () => {
    const hourly = await import('@/app/api/internal/scheduled/billing-hourly/route');
    const daily = await import('@/app/api/internal/scheduled/billing-daily/route');
    for (const [route, path] of [
      [hourly, BILLING_HOURLY_PATH],
      [daily, BILLING_DAILY_PATH],
    ] as const) {
      const outside = await route.POST(
        new Request(`https://xecret.playxoft.com${path}`, {
          method: 'POST',
          headers: { 'x-xecret-scheduled': 'a guess' },
        }),
      );
      expect(outside.status).toBe(404);
      expect(await outside.text()).toBe('');
    }
  });
});

describe('runHourlyBillingJob', () => {
  it('does nothing on a deployment without payments', async () => {
    const report = await runHourlyBillingJob(services({ XECRET_ENV: 'production' }), NOW);
    expect(report).toEqual({ ended: 0, seatSyncs: 0, usage: null, reminders: 0, failures: [] });
  });

  it('returns a cancellation to Free once its paid period is over — after Dodo has had its chance', async () => {
    const lapsed = await seedOrg({
      cancel_at_period_end: true,
      current_period_end: new Date(NOW.getTime() - CANCELLATION_GRACE_MS - 60_000),
    });
    const justEnded = await seedOrg({
      cancel_at_period_end: true,
      current_period_end: new Date(NOW.getTime() - 60_000),
    });

    await runHourlyBillingJob(services(), NOW);

    expect(await findSubscription(t.db, lapsed)).toMatchObject({
      plan: 'free',
      billingInterval: null,
      seats: 1,
      cancelAtPeriodEnd: false,
    });
    const limit = await t.pg.query<{ seat_limit: number }>(
      `select seat_limit from organizations where id = $1`,
      [lapsed],
    );
    expect(limit.rows[0]!.seat_limit).toBe(FREE_SEAT_LIMIT);
    // Still inside the grace: Dodo's own event is waited for.
    expect((await findSubscription(t.db, justEnded))?.plan).toBe('team');

    const audit = await t.pg.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_logs where org_id = $1 and action = 'plan.changed'`,
      [lapsed],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ plan: 'free', previousPlan: 'team' });
  });

  it('retries a seat-sync debt, with backoff', async () => {
    const owed = await seedOrg({ seats: 3 }, 5);
    await t.pg.query(
      `insert into billing_seat_syncs (org_id, attempts, last_attempt_at) values ($1, 0, null)`,
      [owed],
    );
    const waiting = await seedOrg({ seats: 3 }, 5);
    await t.pg.query(
      `insert into billing_seat_syncs (org_id, attempts, last_attempt_at) values ($1, 3, $2)`,
      [waiting, new Date(NOW.getTime() - 60_000)],
    );

    await runHourlyBillingJob(services(), NOW);

    const pushedFor = dodo.changePlan.mock.calls.map((call) => call[0] as string);
    expect(pushedFor).toContain(`sub_${owed.slice(0, 12).replaceAll('-', '')}`);
    expect(pushedFor).not.toContain(`sub_${waiting.slice(0, 12).replaceAll('-', '')}`);
    expect((await findSubscription(t.db, owed))?.seats).toBe(5);
  });

  it('sends the dated reminders once — trial, yearly renewal, usage — and never twice', async () => {
    await seedOrg({ status: 'trialing', trial_ends_at: new Date(NOW.getTime() + 2 * DAY) });
    await seedOrg({ status: 'trialing', trial_ends_at: new Date(NOW.getTime() + 12 * 3_600_000) });
    await seedOrg({
      billing_interval: 'yearly',
      dodo_product_id: 'pdt_team_y',
      current_period_end: new Date(NOW.getTime() + 5 * DAY),
      renewal_amount_minor: 43_200,
      currency: 'USD',
    });
    const heavy = await seedOrg({});
    await t.pg.query(
      `insert into org_usage_counters (org_id, period_start, secret_fetches)
       select org_id, current_period_start, 850000 from org_subscriptions where org_id = $1`,
      [heavy],
    );

    await runHourlyBillingJob(services(), NOW);
    const first = subjects();
    expect(first.some((subject) => /trial for Acme ends in 3 days/.test(subject))).toBe(true);
    expect(first.some((subject) => /trial for Acme ends tomorrow/.test(subject))).toBe(true);
    expect(first.some((subject) => /yearly Team subscription renews/.test(subject))).toBe(true);
    expect(first.some((subject) => /has used 80%/.test(subject))).toBe(true);
    const renewal = mail.sent.find((message) => /renews/.test(message.subject))!;
    expect(renewal.text).toContain('$432.00 before tax');

    mail.sent = [];
    await runHourlyBillingJob(services(), new Date(NOW.getTime() + 3_600_000));
    expect(subjects().filter((subject) => /trial|renews|80%/.test(subject))).toEqual([]);
  });

  it('checks cards once a day, and warns only when no saved card outlives the window', async () => {
    const expiring = await seedOrg({});
    const renewed = await seedOrg({});
    const atCardHour = new Date(Date.UTC(2026, 9, 20, CARD_CHECK_HOUR_UTC, 17));
    dodo.cardExpiries.mockImplementation(async (customerId: string) =>
      customerId === `cus_${expiring.slice(0, 12).replaceAll('-', '')}`
        ? new Map([['pm_1', { month: 10, year: 2026 }]])
        : new Map([
            ['pm_old', { month: 10, year: 2026 }],
            ['pm_new', { month: 4, year: 2030 }],
          ]),
    );
    void renewed;

    await runHourlyBillingJob(services(), NOW);
    expect(dodo.cardExpiries).not.toHaveBeenCalled();

    await runHourlyBillingJob(services(), atCardHour);
    const cards = mail.sent.filter((message) => /card for Acme expires/.test(message.subject));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain('Your builds are unaffected');
  });
});

describe('the nightly reconciler', () => {
  const config = (() => {
    const setup = billingSetup(BILLING_ENV as never);
    if (setup.state !== 'enabled') throw new Error('fixture');
    return setup.config;
  })();

  function snapshotFor(over: Partial<DodoSubscription> = {}): DodoSubscription {
    return {
      subscription_id: 'sub_x',
      status: 'active',
      product_id: 'pdt_team_m',
      quantity: 3,
      currency: 'USD',
      customer: { customer_id: 'cus_x' },
      billing: { country: 'US' },
      metadata: {},
      next_billing_date: new Date(NOW.getTime() + 25 * DAY).toISOString(),
      previous_billing_date: new Date(NOW.getTime() - 5 * DAY).toISOString(),
      cancel_at_next_billing_date: false,
      trial_period_days: 0,
      created_at: new Date(NOW.getTime() - 5 * DAY).toISOString(),
      recurring_pre_tax_amount: 5700,
      addons: [],
      ...over,
    };
  }

  it('names each field that disagrees', async () => {
    const orgId = await seedOrg({});
    const row = (await findSubscription(t.db, orgId))!;
    expect(driftBetween(row, snapshotFor(), config, false)).toEqual([]);
    expect(
      driftBetween(
        row,
        snapshotFor({ quantity: 7, status: 'on_hold', product_id: 'pdt_pro_m' }),
        config,
        false,
      ),
    ).toEqual(['product', 'plan', 'status', 'seats']);
    // A queued seat push explains a seat difference.
    expect(driftBetween(row, snapshotFor({ quantity: 7 }), config, true)).toEqual([]);
    expect(
      driftBetween(row, snapshotFor({ cancel_at_next_billing_date: true }), config, false),
    ).toEqual(['cancelAtPeriodEnd']);
  });

  it('reports drift, alerts a human, and corrects nothing', async () => {
    const orgId = await seedOrg({});
    dodo.getSubscription.mockImplementation(async (id: string) =>
      id === `sub_${orgId.slice(0, 12).replaceAll('-', '')}`
        ? snapshotFor({ quantity: 9 })
        : snapshotFor({ quantity: 3 }),
    );

    const report = await reconcileSubscriptions(services());

    expect(report.drifted).toBeGreaterThanOrEqual(1);
    expect((await findSubscription(t.db, orgId))?.seats).toBe(3);
    const audit = await t.pg.query<{ metadata: Record<string, unknown>; outcome: string }>(
      `select metadata, outcome from audit_logs where org_id = $1 and action = 'billing.drift_detected'`,
      [orgId],
    );
    expect(audit.rows[0]).toMatchObject({ outcome: 'error', metadata: { driftFields: ['seats'] } });
    expect(
      lines.some((line) => line.level === 'error' && /nothing was corrected/.test(line.message)),
    ).toBe(true);
    expect(dodo.changePlan).not.toHaveBeenCalled();
  });

  it('reports a subscription Dodo no longer has, and skips one it could not ask about', async () => {
    const missing = await seedOrg({});
    const flaky = await seedOrg({});
    dodo.getSubscription.mockImplementation(async (id: string) => {
      if (id === `sub_${missing.slice(0, 12).replaceAll('-', '')}`)
        throw new DodoApiError('not_found', 404);
      if (id === `sub_${flaky.slice(0, 12).replaceAll('-', '')}`)
        throw new DodoApiError('upstream_5xx', 503);
      return snapshotFor();
    });

    const report = await reconcileSubscriptions(services());
    expect(report.unreachable).toBeGreaterThanOrEqual(1);
    const audit = await t.pg.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_logs where org_id = $1 and action = 'billing.drift_detected'`,
      [missing],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({ driftFields: ['missing'] });
    const none = await t.pg.query(
      `select 1 from audit_logs where org_id = $1 and action = 'billing.drift_detected'`,
      [flaky],
    );
    expect(none.rows).toHaveLength(0);
  });
});
