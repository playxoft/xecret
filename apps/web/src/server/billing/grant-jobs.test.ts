import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '@xecret/db/testing';
import type { TestDatabase } from '@xecret/db/testing';
import { findSubscription } from '@xecret/db/repositories';
import type { ServiceContext } from '../context';
import { createLogger } from '../logging';
import type { MailMessage } from '../mail';

/**
 * The hourly job's first step (migration 0035): complimentary plans that
 * reach their end date return to Free, and their owners are told a week and a
 * day before — whether or not the deployment takes payments, and without ever
 * calling Dodo. Against a real database, with Dodo and the mailer stubbed.
 */

const dodo = vi.hoisted(() => ({
  changePlan: vi.fn(),
  ingestUsage: vi.fn(),
  getSubscription: vi.fn(),
  cardExpiries: vi.fn(),
  createDiscount: vi.fn(),
  deleteDiscount: vi.fn(),
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

const { runHourlyBillingJob, CARD_CHECK_HOUR_UTC } = await import('./jobs');

let t: TestDatabase;

const ORIGIN = 'https://xecret.playxoft.com';
const NO_BILLING_ENV = { XECRET_ENV: 'production', XECRET_PUBLIC_URL: ORIGIN };
const BILLING_ENV = {
  ...NO_BILLING_ENV,
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
      sink: { write: () => {}, flush: () => Promise.resolve() },
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
  dodo.ingestUsage.mockResolvedValue(undefined);
  dodo.cardExpiries.mockResolvedValue(new Map());
  mail.sent = [];
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The real clock, moved off the card-check hour so no run here asks Dodo about cards. */
const NOW = (() => {
  const real = new Date();
  return real.getUTCHours() === CARD_CHECK_HOUR_UTC ? new Date(real.getTime() + HOUR) : real;
})();

/** An organisation on a complimentary Team plan — no Dodo subscription — ending at `endsAt`. */
async function seedGrant(endsAt: Date | null, name = 'Acme'): Promise<string> {
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
    `insert into organizations (id, name, slug, created_by, seat_limit) values ($1, $2, $3, $4, 10)`,
    [orgId, name, `grant-${orgId.slice(0, 8)}`, ownerId],
  );
  await t.pg.query(
    `insert into org_subscriptions (org_id, plan, billing_interval, status, seats, grant_ends_at, grant_note)
     values ($1, 'team', 'yearly', 'active', 10, $2, 'Granted by xecret support')`,
    [orgId, endsAt],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, ownerId],
  );
  return orgId;
}

async function remindersOf(orgId: string): Promise<{ kind: string; occasion: string }[]> {
  const rows = await t.pg.query<{ kind: string; occasion: string }>(
    `select kind, occasion from billing_reminders where org_id = $1 order by kind`,
    [orgId],
  );
  return rows.rows;
}

async function seatLimitOf(orgId: string): Promise<number> {
  const rows = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return rows.rows[0]!.seat_limit;
}

describe('the hourly job’s complimentary plans', () => {
  it('returns a grant to Free once its end date has passed, audits it, and tells the owners', async () => {
    const endsAt = new Date(NOW.getTime() - 60_000);
    const orgId = await seedGrant(endsAt, 'Ended Co');

    const report = await runHourlyBillingJob(services(), NOW);

    expect(report.grantsEnded).toBe(1);
    expect(report.failures).toEqual([]);
    expect(await findSubscription(t.db, orgId)).toMatchObject({
      plan: 'free',
      billingInterval: null,
      status: 'active',
      seats: 1,
      grantEndsAt: null,
      grantNote: null,
    });
    expect(await seatLimitOf(orgId)).toBe(FREE_SEAT_LIMIT);

    const audit = await t.pg.query<{
      actor_type: string;
      actor_label: string;
      outcome: string;
      metadata: Record<string, unknown>;
    }>(
      `select actor_type, actor_label, outcome, metadata from audit_logs
       where org_id = $1 and action = 'plan.changed'`,
      [orgId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'system',
      actor_label: 'billing job',
      outcome: 'success',
      metadata: {
        plan: 'free',
        previousPlan: 'team',
        seatCount: 1,
        previousSeatCount: 10,
        reason: 'complimentary plan reached its end date',
      },
    });

    // Claimed once, for the date the grant ended on.
    expect(await remindersOf(orgId)).toEqual([
      { kind: 'grant_ended', occasion: endsAt.toISOString() },
    ]);
    expect(mail.sent.map((message) => message.subject)).toContain(
      'Ended Co has moved to the Free plan',
    );
    // Nothing about a grant is Dodo's.
    expect(dodo.changePlan).not.toHaveBeenCalled();
    expect(dodo.getSubscription).not.toHaveBeenCalled();
  });

  it('reminds a week out, then a day out, keyed by the end date', async () => {
    const inThreeDays = new Date(NOW.getTime() + 3 * DAY);
    const inTwelveHours = new Date(NOW.getTime() + 12 * HOUR);
    const weekOut = await seedGrant(inThreeDays, 'Week Co');
    const dayOut = await seedGrant(inTwelveHours, 'Day Co');

    const report = await runHourlyBillingJob(services(), NOW);

    expect(report.grantsEnded).toBe(0);
    expect(await remindersOf(weekOut)).toEqual([
      { kind: 'grant_ending_7d', occasion: inThreeDays.toISOString() },
    ]);
    expect(await remindersOf(dayOut)).toEqual([
      { kind: 'grant_ending_1d', occasion: inTwelveHours.toISOString() },
    ]);
    const subjects = mail.sent.map((message) => message.subject);
    expect(
      subjects.some((subject) => /^Week Co's complimentary Team plan ends on /.test(subject)),
    ).toBe(true);
    expect(
      subjects.some((subject) => /^Day Co's complimentary Team plan ends on /.test(subject)),
    ).toBe(true);
    // Neither has ended.
    expect((await findSubscription(t.db, weekOut))?.plan).toBe('team');
    expect((await findSubscription(t.db, dayOut))?.plan).toBe('team');
  });

  it('never sends the same reminder twice, however many runs see the grant', async () => {
    const inFourDays = new Date(NOW.getTime() + 4 * DAY);
    const orgId = await seedGrant(inFourDays, 'Once Co');

    await runHourlyBillingJob(services(), NOW);
    expect(mail.sent.filter((message) => message.subject.startsWith('Once Co'))).toHaveLength(1);

    mail.sent = [];
    const again = await runHourlyBillingJob(services(), new Date(NOW.getTime() + HOUR));
    expect(again.reminders).toBe(0);
    expect(mail.sent.filter((message) => message.subject.startsWith('Once Co'))).toEqual([]);
    expect(await remindersOf(orgId)).toEqual([
      { kind: 'grant_ending_7d', occasion: inFourDays.toISOString() },
    ]);
  });

  it('reminds again for the new date when a grant is extended', async () => {
    const first = new Date(NOW.getTime() + 2 * DAY);
    const orgId = await seedGrant(first, 'Extended Co');
    await runHourlyBillingJob(services(), NOW);

    // An admin moved the end five days later — still inside the week.
    const extended = new Date(first.getTime() + 3 * DAY);
    await t.pg.query(`update org_subscriptions set grant_ends_at = $2 where org_id = $1`, [
      orgId,
      extended,
    ]);
    await runHourlyBillingJob(services(), new Date(NOW.getTime() + HOUR));

    expect(await remindersOf(orgId)).toEqual([
      { kind: 'grant_ending_7d', occasion: first.toISOString() },
      { kind: 'grant_ending_7d', occasion: extended.toISOString() },
    ]);
  });

  it('leaves a grant with no end, and one more than a week out, alone', async () => {
    const forever = await seedGrant(null, 'Forever Co');
    const later = await seedGrant(new Date(NOW.getTime() + 10 * DAY), 'Later Co');

    const report = await runHourlyBillingJob(services(), NOW);

    expect(report.grantsEnded).toBe(0);
    for (const orgId of [forever, later]) {
      expect((await findSubscription(t.db, orgId))?.plan).toBe('team');
      expect(await remindersOf(orgId)).toEqual([]);
    }
  });

  it('ends and reminds on a deployment that takes no payments — grants need nothing from Dodo', async () => {
    const endsAt = new Date(NOW.getTime() - 5 * 60_000);
    const due = await seedGrant(endsAt, 'Unpaid Co');
    const soon = await seedGrant(new Date(NOW.getTime() + 2 * DAY), 'Soon Co');

    const report = await runHourlyBillingJob(services(NO_BILLING_ENV), NOW);

    expect(report).toMatchObject({
      ended: 0,
      grantsEnded: 1,
      seatSyncs: 0,
      usage: null,
      reminders: 1,
      failures: [],
    });
    expect(await findSubscription(t.db, due)).toMatchObject({
      plan: 'free',
      grantEndsAt: null,
      grantNote: null,
    });
    expect(await seatLimitOf(due)).toBe(FREE_SEAT_LIMIT);
    expect(await remindersOf(due)).toEqual([
      { kind: 'grant_ended', occasion: endsAt.toISOString() },
    ]);
    expect(await remindersOf(soon)).toEqual([
      { kind: 'grant_ending_7d', occasion: expect.any(String) },
    ]);
    for (const fn of Object.values(dodo)) expect(fn).not.toHaveBeenCalled();
  });

  // The payments step's reminders are added to the grants step's count, never
  // assigned over it — which once made grant reminders vanish from the report.
  it('counts grant reminders in the report when payments are on too', async () => {
    const orgId = await seedGrant(new Date(NOW.getTime() + 5 * DAY), 'Counted Co');

    const report = await runHourlyBillingJob(services(), NOW);

    expect(await remindersOf(orgId)).toHaveLength(1);
    expect(report.reminders).toBe(1);
  });

  it('does not end a grant on an organisation that was deleted', async () => {
    const orgId = await seedGrant(new Date(NOW.getTime() - 60_000), 'Gone Co');
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);

    const report = await runHourlyBillingJob(services(NO_BILLING_ENV), NOW);

    expect(report.grantsEnded).toBe(0);
    expect((await findSubscription(t.db, orgId))?.plan).toBe('team');
    expect(await remindersOf(orgId)).toEqual([]);
  });
});
