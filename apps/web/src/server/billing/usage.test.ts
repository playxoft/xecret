import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { addFetchCounts, currentUsage } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { createLogger } from '../logging';
import type { LogEntry } from '../logging';
import type { UsageEvent } from './client';

/**
 * Usage metering: counting a secret fetch costs the fetch nothing and can
 * never fail it; reporting the overage cannot bill a unit twice. Dodo is a
 * stub — no event here reaches it.
 */

const dodo = vi.hoisted(() => ({ ingestUsage: vi.fn() }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  billingProvider: () => dodo,
}));

const usage = await import('./usage');
const { DodoApiError } = await import('./client');

let t: TestDatabase;
let lines: LogEntry[] = [];
let deferred: Promise<unknown>[] = [];

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

function services(over: { env?: Record<string, unknown>; db?: unknown } = {}): ServiceContext {
  return {
    env: (over.env ?? BILLING_ENV) as never,
    db: (over.db ?? t.db) as never,
    log: createLogger({
      sink: { write: (entry) => lines.push(entry), flush: () => Promise.resolve() },
      minimum: 'debug',
    }).logger,
    meta: {
      requestId: randomUUID(),
      rayId: null,
      ipAddress: null,
      userAgent: null,
      method: 'GET',
      path: '/',
      startedAt: Date.now(),
    },
    waitUntil: (promise: Promise<unknown>) => void deferred.push(promise),
  } as unknown as ServiceContext;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  usage.resetFetchCounterForTesting();
  dodo.ingestUsage.mockReset();
  dodo.ingestUsage.mockResolvedValue(undefined);
  lines = [];
  deferred = [];
  vi.useRealTimers();
});

async function seedOrg(subscription: Record<string, unknown> = {}): Promise<string> {
  const ownerId = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [
      ownerId,
      `user_01${ownerId.replaceAll('-', '').slice(0, 20)}`,
      `u-${ownerId.slice(0, 8)}@example.com`,
    ],
  );
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId],
  );
  const columns = ['org_id', ...Object.keys(subscription)];
  await t.pg.query(
    `insert into org_subscriptions (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    [orgId, ...Object.values(subscription)],
  );
  return orgId;
}

const PERIOD_START = new Date(Date.now() - 3 * 86_400_000);

/** A Team subscription Dodo bills, inside its period. */
const billedTeam = () =>
  seedOrg({
    plan: 'team',
    billing_interval: 'monthly',
    status: 'active',
    seats: 3,
    dodo_customer_id: `cus_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    dodo_subscription_id: `sub_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    dodo_product_id: 'pdt_team_m',
    current_period_start: PERIOD_START,
    current_period_end: new Date(Date.now() + 27 * 86_400_000),
    metered_from: PERIOD_START,
  });

async function setFetches(orgId: string, fetches: number, unitsSent = 0) {
  await t.pg.query(
    `insert into org_usage_counters (org_id, period_start, secret_fetches, metered_units_sent)
     values ($1, $2, $3, $4)
     on conflict (org_id, period_start) do update
       set secret_fetches = excluded.secret_fetches, updated_at = now()`,
    [orgId, PERIOD_START, fetches, unitsSent],
  );
}

async function unitsSent(orgId: string): Promise<number> {
  const result = await t.pg.query<{ metered_units_sent: string }>(
    `select metered_units_sent from org_usage_counters where org_id = $1 and period_start = $2`,
    [orgId, PERIOD_START],
  );
  return Number(result.rows[0]?.metered_units_sent ?? 0);
}

const sentEvents = (): UsageEvent[] =>
  dodo.ingestUsage.mock.calls.flatMap((call) => call[0] as UsageEvent[]);

const DAY = 86_400_000;

/** `anchor` plus `months` calendar months in UTC, a missing day clamped to the month's last. */
function plusMonthsUtc(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

describe('countSecretFetch', () => {
  /** Lets the flush timer a count armed run out, and waits for what it wrote. */
  async function afterInterval(): Promise<void> {
    await vi.advanceTimersByTimeAsync(usage.FLUSH_INTERVAL_MS);
    await Promise.allSettled(deferred);
  }

  it('writes nothing on the fetch itself, and flushes from waitUntil', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orgId = await seedOrg();
    const before = t.statements.length;
    usage.countSecretFetch(services(), orgId);
    // Nothing was awaited and nothing was sent: the flush is only queued.
    expect(t.statements.length).toBe(before);
    expect(deferred).toHaveLength(1);
    await afterInterval();
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(1);
  });

  it('flushes a quiet isolate within the interval, without waiting for another fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orgId = await seedOrg();
    const ctx = services();
    for (let index = 0; index < 3; index += 1) usage.countSecretFetch(ctx, orgId);
    // No fetch follows — the isolate goes quiet. The first count's own
    // waitUntil holds the timer that writes them.
    await vi.advanceTimersByTimeAsync(usage.FLUSH_INTERVAL_MS - 1000);
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(0);
    await afterInterval();
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(3);
  });

  it('accumulates between flushes and loses nothing it was told', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orgId = await seedOrg();
    const ctx = services();
    for (let index = 0; index < 21; index += 1) usage.countSecretFetch(ctx, orgId);
    // One timer for all of them, under the threshold: held until it fires.
    expect(deferred).toHaveLength(1);
    await afterInterval();
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(21);
  });

  it('flushes once enough fetches are waiting, without waiting for the interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orgId = await seedOrg();
    const ctx = services();
    for (let index = 0; index < usage.FLUSH_AT_COUNT; index += 1)
      usage.countSecretFetch(ctx, orgId);
    // The timer the first one armed, and the flush the fiftieth triggered.
    expect(deferred).toHaveLength(2);
    await Promise.all([deferred[1]]);
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(usage.FLUSH_AT_COUNT);
  });

  it('drops a batch whose write failed rather than risk counting it twice — and never throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orgId = await seedOrg();
    const broken = services({
      db: { execute: () => Promise.reject(new Error('connection reset')) },
    });
    expect(() => usage.countSecretFetch(broken, orgId)).not.toThrow();
    await afterInterval();
    expect(lines.some((line) => line.level === 'warn' && /dropped/.test(line.message))).toBe(true);

    // The next flush starts from nothing: the failed batch is not resent.
    usage.countSecretFetch(services(), orgId);
    await usage.flushFetchCounts(services());
    await afterInterval();
    expect((await currentUsage(t.db, orgId)).secretFetches).toBe(1);
  });
});

describe('flushUsageToDodo', () => {
  it('reports one deterministic event per thousand fetches past the allowance', async () => {
    const orgId = await billedTeam();
    await setFetches(orgId, 1_002_500); // Team includes 1,000,000

    const report = await usage.flushUsageToDodo(services());

    expect(report).toMatchObject({ units: 2, failures: 0 });
    expect(sentEvents().map((event) => event.eventId)).toEqual([
      usage.meterEventId(orgId, PERIOD_START, 0),
      usage.meterEventId(orgId, PERIOD_START, 1),
    ]);
    expect(sentEvents()[0]).toMatchObject({ eventName: 'secret_fetch_kilo' });
    expect(await unitsSent(orgId)).toBe(2);

    const audit = await t.pg.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_logs where org_id = $1 and action = 'billing.usage_reported'`,
      [orgId],
    );
    expect(audit.rows.map((row) => row.metadata)).toEqual([{ unitCount: 2 }]);
  });

  it('reports nothing twice — a second run sends no events, a later one only the new unit', async () => {
    const orgId = await billedTeam();
    await setFetches(orgId, 1_002_500);
    await usage.flushUsageToDodo(services());
    dodo.ingestUsage.mockClear();

    await usage.flushUsageToDodo(services());
    expect(sentEvents()).toEqual([]);

    await setFetches(orgId, 1_003_999, 2);
    await usage.flushUsageToDodo(services());
    expect(sentEvents().map((event) => event.eventId)).toEqual([
      usage.meterEventId(orgId, PERIOD_START, 2),
    ]);
  });

  it('records only what Dodo accepted, so a failure part-way is resumed with the same ids', async () => {
    const orgId = await billedTeam();
    await setFetches(orgId, 1_000_000 + 1_500_000); // 1,500 units: two requests
    dodo.ingestUsage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DodoApiError('upstream_5xx', 502));

    const report = await usage.flushUsageToDodo(services());
    expect(report.failures).toBe(1);
    expect(await unitsSent(orgId)).toBe(1_000);

    dodo.ingestUsage.mockReset();
    dodo.ingestUsage.mockResolvedValue(undefined);
    await usage.flushUsageToDodo(services());
    const ids = sentEvents().map((event) => event.eventId);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe(usage.meterEventId(orgId, PERIOD_START, 1_000));
    expect(await unitsSent(orgId)).toBe(1_500);
  });

  it('honours a support override of the allowance', async () => {
    const orgId = await billedTeam();
    await t.pg.query(
      `update org_subscriptions set limit_overrides = '{"includedFetchesPerMonth": 5000000}' where org_id = $1`,
      [orgId],
    );
    await setFetches(orgId, 1_200_000);
    await usage.flushUsageToDodo(services());
    expect(sentEvents()).toEqual([]);
  });

  it('never bills what was fetched before the subscription — Free usage, then an upgrade', async () => {
    // A heavy month on Free, then a Team checkout three days ago.
    const orgId = await billedTeam();
    const freeMonth = new Date(PERIOD_START.getTime() - 20 * 86_400_000);
    await t.pg.query(
      `insert into org_usage_counters (org_id, period_start, secret_fetches) values ($1, $2, $3)`,
      [orgId, freeMonth, 9_000_000],
    );
    await setFetches(orgId, 1_000_500); // the paid period: no whole unit over yet

    const report = await usage.flushUsageToDodo(services());
    expect(report.units).toBe(0);
    expect(sentEvents()).toEqual([]);
  });

  it('never bills a trial’s usage once it converts', async () => {
    const trialEnd = PERIOD_START;
    const orgId = await seedOrg({
      plan: 'team',
      billing_interval: 'monthly',
      status: 'active',
      seats: 3,
      dodo_customer_id: `cus_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      dodo_subscription_id: `sub_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      dodo_product_id: 'pdt_team_m',
      current_period_start: trialEnd,
      current_period_end: new Date(Date.now() + 27 * 86_400_000),
      trial_ends_at: trialEnd,
      metered_from: trialEnd,
    });
    await t.pg.query(
      `insert into org_usage_counters (org_id, period_start, secret_fetches) values ($1, $2, $3)`,
      [orgId, new Date(trialEnd.getTime() - 14 * 86_400_000), 5_000_000],
    );
    await usage.flushUsageToDodo(services());
    expect(sentEvents().filter((event) => event.eventId.startsWith(orgId))).toEqual([]);
  });

  it('meters a yearly plan by the month of its year: 100k a month on Pro is never billed', async () => {
    const anchor = new Date(Date.now() - 70 * 86_400_000);
    const orgId = await seedOrg({
      plan: 'pro',
      billing_interval: 'yearly',
      status: 'active',
      dodo_customer_id: `cus_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      dodo_subscription_id: `sub_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      dodo_product_id: 'pdt_pro_y',
      current_period_start: anchor,
      current_period_end: new Date(anchor.getTime() + 365 * 86_400_000),
      metered_from: anchor,
    });
    const inMonth = (month: number) => new Date(plusMonthsUtc(anchor, month).getTime() + 5 * DAY);
    // 300k in the year so far — 100k in each month, against Pro's 200k a month.
    await addFetchCounts(
      t.db,
      [0, 1, 2].map((month) => ({ orgId, fetches: 100_000, countedAt: inMonth(month) })),
    );
    await usage.flushUsageToDodo(services());
    expect(sentEvents().filter((event) => event.eventId.startsWith(orgId))).toEqual([]);

    // The second month goes to 205k: five units over, billed once, in that month.
    await addFetchCounts(t.db, [{ orgId, fetches: 105_000, countedAt: inMonth(1) }]);
    await usage.flushUsageToDodo(services());
    const month = plusMonthsUtc(anchor, 1);
    expect(
      sentEvents()
        .filter((event) => event.eventId.startsWith(orgId))
        .map((event) => event.eventId),
    ).toEqual([0, 1, 2, 3, 4].map((unit) => usage.meterEventId(orgId, month, unit)));
  });

  it('never meters a trial, Free, an operator’s grant, or a deployment with payments off', async () => {
    const trial = await seedOrg({
      plan: 'team',
      billing_interval: 'monthly',
      status: 'trialing',
      dodo_customer_id: 'cus_trial000001',
      dodo_subscription_id: `sub_${randomUUID().slice(0, 12)}`,
    });
    const free = await seedOrg();
    const manual = await seedOrg({ plan: 'enterprise', billing_interval: 'yearly' });
    for (const orgId of [trial, free, manual]) await setFetches(orgId, 50_000_000);

    await usage.flushUsageToDodo(services());
    const metered = new Set(sentEvents().map((event) => event.eventId.split(':')[0]));
    expect(metered.has(trial)).toBe(false);
    expect(metered.has(free)).toBe(false);
    expect(metered.has(manual)).toBe(false);

    const paid = await billedTeam();
    await setFetches(paid, 2_000_000);
    dodo.ingestUsage.mockClear();
    await usage.flushUsageToDodo(services({ env: { XECRET_ENV: 'production' } }));
    expect(dodo.ingestUsage).not.toHaveBeenCalled();
  });
});
