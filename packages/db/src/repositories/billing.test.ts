import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  addFetchCounts,
  billingCounts,
  claimReminder,
  completeSeatSync,
  currentUsage,
  failSeatSync,
  findCheckout,
  findOrgIdByDodoCustomer,
  findOrgIdByDodoSubscription,
  listEndedCancellations,
  listMeterableUsage,
  listOwnerRecipients,
  listProviderSubscriptions,
  listSeatSyncs,
  liveOrganizationExists,
  lockSubscription,
  markMeteredUnitsSent,
  queueSeatSync,
  recordCheckout,
  recordLicenseKey,
  reminderSentSince,
  seatedMemberCount,
  writeSubscriptionState,
} from './billing';

/**
 * Migration 0024 and the payment repositories (P12), against a real database —
 * because what matters here is what a predicate admits, what a constraint
 * refuses and what a conflict clause sums, and none of that is visible in the
 * generated SQL.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

async function seedUser(over: { deleted?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified, deleted_at)
     values ($1, $2, $3, true, $4)`,
    [
      id,
      `user_01${id.replaceAll('-', '').slice(0, 20)}`,
      `person-${id.slice(0, 8)}@example.com`,
      over.deleted ? new Date() : null,
    ],
  );
  return id;
}

interface Seeded {
  orgId: string;
  ownerId: string;
}

async function seedOrg(
  subscription: {
    plan?: string;
    interval?: string | null;
    status?: string;
    customer?: string | null;
    dodoSubscription?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  } = {},
): Promise<Seeded> {
  const ownerId = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by) values ($1, 'Acme', $2, $3)`,
    [orgId, `acme-${orgId.slice(0, 8)}`, ownerId],
  );
  const plan = subscription.plan ?? 'free';
  await t.pg.query(
    `insert into org_subscriptions
       (org_id, plan, billing_interval, status, dodo_customer_id, dodo_subscription_id,
        current_period_start, current_period_end, cancel_at_period_end)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      plan,
      subscription.interval === undefined
        ? plan === 'free'
          ? null
          : 'monthly'
        : subscription.interval,
      subscription.status ?? 'active',
      subscription.customer ?? null,
      subscription.dodoSubscription ?? null,
      subscription.periodStart ?? null,
      subscription.periodEnd ?? null,
      subscription.cancelAtPeriodEnd ?? false,
    ],
  );
  await addMember(orgId, ownerId, 'owner');
  return { orgId, ownerId };
}

async function addMember(
  orgId: string,
  userId: string,
  role: string,
  over: { status?: string } = {},
): Promise<void> {
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role, status) values ($1, $2, $3, $4, $5)`,
    [randomUUID(), orgId, userId, role, over.status ?? 'active'],
  );
}

async function seatLimitOf(orgId: string): Promise<number> {
  const result = await t.pg.query<{ seat_limit: number }>(
    `select seat_limit from organizations where id = $1`,
    [orgId],
  );
  return result.rows[0]!.seat_limit;
}

const DAY = 24 * 60 * 60 * 1000;
const uniq = () => randomUUID().replaceAll('-', '').slice(0, 16);

describe('migration 0024', () => {
  it('adds the four subscription columns, nullable', async () => {
    const result = await t.pg.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'org_subscriptions'
          and column_name in ('current_period_start', 'dodo_product_id', 'dodo_event_at', 'renewal_amount_minor')
        order by column_name`,
    );
    expect(result.rows).toEqual([
      { column_name: 'current_period_start', is_nullable: 'YES' },
      { column_name: 'dodo_event_at', is_nullable: 'YES' },
      { column_name: 'dodo_product_id', is_nullable: 'YES' },
      { column_name: 'renewal_amount_minor', is_nullable: 'YES' },
    ]);
  });

  it('holds the Free seat ceiling the column default already holds', async () => {
    // `FREE_SEAT_LIMIT` is what a lapsed subscription returns an organisation
    // to; it must be the number every Free organisation already has.
    const result = await t.pg.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_name = 'organizations' and column_name = 'seat_limit'`,
    );
    expect(Number(result.rows[0]!.column_default)).toBe(FREE_SEAT_LIMIT);
  });

  it('refuses a checkout for Free, or for no seats', async () => {
    const { orgId } = await seedOrg();
    await expect(
      t.pg.query(
        `insert into billing_checkouts (session_id, org_id, plan, billing_interval, quantity)
         values ($1, $2, 'free', 'monthly', 1)`,
        [`cks_${uniq()}`, orgId],
      ),
    ).rejects.toThrow(/billing_checkouts_plan_check/);
    await expect(
      t.pg.query(
        `insert into billing_checkouts (session_id, org_id, plan, billing_interval, quantity)
         values ($1, $2, 'team', 'monthly', 0)`,
        [`cks_${uniq()}`, orgId],
      ),
    ).rejects.toThrow(/billing_checkouts_quantity_check/);
  });

  it('refuses a reminder kind nobody defined', async () => {
    const { orgId } = await seedOrg();
    await expect(
      t.pg.query(
        `insert into billing_reminders (org_id, kind, occasion) values ($1, 'promo', 'x')`,
        [orgId],
      ),
    ).rejects.toThrow(/billing_reminders_kind_check/);
  });

  it('has no column for a licence key itself', async () => {
    const result = await t.pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'billing_license_keys'`,
    );
    const names = result.rows.map((row) => row.column_name);
    expect(names).toContain('license_key_id');
    expect(names).not.toContain('key');
    expect(names.some((name) => name === 'license_key' || name === 'key_value')).toBe(false);
  });
});

describe('locating an organisation from an event', () => {
  it('finds a subscription by its provider id', async () => {
    const id = `sub_${uniq()}`;
    const { orgId } = await seedOrg({ plan: 'team', dodoSubscription: id });
    expect(await findOrgIdByDodoSubscription(t.db, id)).toBe(orgId);
    expect(await findOrgIdByDodoSubscription(t.db, `sub_${uniq()}`)).toBeNull();
  });

  it('places an event by customer only when exactly one organisation holds that customer', async () => {
    const shared = `cus_${uniq()}`;
    const only = `cus_${uniq()}`;
    const { orgId } = await seedOrg({ customer: only });
    await seedOrg({ customer: shared });
    await seedOrg({ customer: shared });

    expect(await findOrgIdByDodoCustomer(t.db, only)).toBe(orgId);
    // One person can own two organisations that each bought a plan: ambiguous,
    // so nobody is guessed.
    expect(await findOrgIdByDodoCustomer(t.db, shared)).toBeNull();
  });

  it('confirms an organisation named in metadata exists and is live', async () => {
    const { orgId } = await seedOrg();
    expect(await liveOrganizationExists(t.db, orgId)).toBe(true);
    await t.pg.query(`update organizations set deleted_at = now() where id = $1`, [orgId]);
    expect(await liveOrganizationExists(t.db, orgId)).toBe(false);
    expect(await liveOrganizationExists(t.db, randomUUID())).toBe(false);
  });
});

describe('writeSubscriptionState', () => {
  it('writes the invoice figure and the access ceiling together', async () => {
    const { orgId } = await seedOrg();
    await t.db.transaction(async (tx) => {
      const locked = await lockSubscription(tx, orgId);
      expect(locked?.plan).toBe('free');
      await writeSubscriptionState(
        tx,
        orgId,
        { plan: 'team', billingInterval: 'yearly', status: 'active', dodoProductId: 'pdt_team_y' },
        { billed: 4, enforced: 100_000 },
      );
    });

    const result = await t.pg.query<{ seats: number; plan: string; dodo_product_id: string }>(
      `select seats, plan, dodo_product_id from org_subscriptions where org_id = $1`,
      [orgId],
    );
    expect(result.rows[0]).toEqual({ seats: 4, plan: 'team', dodo_product_id: 'pdt_team_y' });
    expect(await seatLimitOf(orgId)).toBe(100_000);
  });

  it('leaves the seat ceiling alone when no seats are given', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    const before = await seatLimitOf(orgId);
    await t.db.transaction(async (tx) => {
      await writeSubscriptionState(tx, orgId, { status: 'on_hold' });
    });
    expect(await seatLimitOf(orgId)).toBe(before);
  });

  it('cannot write a paid plan without an interval — the row stays coherent', async () => {
    const { orgId } = await seedOrg();
    await expect(
      t.db.transaction(async (tx) => {
        await writeSubscriptionState(tx, orgId, { plan: 'team', billingInterval: null });
      }),
    ).rejects.toThrow();
  });
});

describe('seatedMemberCount', () => {
  it('counts every seated member, suspended ones included, and no invitation', async () => {
    const { orgId, ownerId } = await seedOrg({ plan: 'team' });
    await addMember(orgId, await seedUser(), 'developer');
    await addMember(orgId, await seedUser(), 'viewer', { status: 'suspended' });
    await t.pg.query(
      `insert into invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'new@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
      [randomUUID(), orgId, new Uint8Array(32).fill(7), ownerId],
    );

    expect(await seatedMemberCount(t.db, orgId)).toBe(3);
    const counts = await billingCounts(t.db, orgId, new Date());
    expect(counts.seatedMembers).toBe(3);
    expect(counts.pendingInvitations).toBe(1);
  });
});

describe('listOwnerRecipients', () => {
  it('names live, active owners only', async () => {
    const { orgId } = await seedOrg();
    const suspendedOwner = await seedUser();
    const deletedOwner = await seedUser({ deleted: true });
    const admin = await seedUser();
    await addMember(orgId, suspendedOwner, 'owner', { status: 'suspended' });
    await addMember(orgId, deletedOwner, 'owner');
    await addMember(orgId, admin, 'admin');

    const recipients = await listOwnerRecipients(t.db, orgId);
    expect(recipients).toHaveLength(1);
  });
});

describe('the seat-sync debt', () => {
  it('is queued once, retried with a count, and paid only by a push that began after it', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    const beforeQueue = new Date(Date.now() - 60_000);

    await queueSeatSync(t.db, orgId);
    await queueSeatSync(t.db, orgId);
    let debts = (await listSeatSyncs(t.db, 100)).filter((row) => row.orgId === orgId);
    expect(debts).toHaveLength(1);

    await failSeatSync(t.db, orgId, 'upstream_5xx');
    await failSeatSync(t.db, orgId, 'upstream_timeout');
    debts = (await listSeatSyncs(t.db, 100)).filter((row) => row.orgId === orgId);
    expect(debts[0]).toMatchObject({ attempts: 2, lastError: 'upstream_timeout' });

    // A push that started before the debt was queued does not clear it.
    await completeSeatSync(t.db, orgId, beforeQueue);
    expect((await listSeatSyncs(t.db, 100)).some((row) => row.orgId === orgId)).toBe(true);

    await completeSeatSync(t.db, orgId, new Date(Date.now() + 1000));
    expect((await listSeatSyncs(t.db, 100)).some((row) => row.orgId === orgId)).toBe(false);
  });
});

describe('the usage counter', () => {
  it('sums concurrent flushes into one row per period', async () => {
    const { orgId } = await seedOrg();
    await Promise.all([
      addFetchCounts(t.db, [{ orgId, fetches: 40 }]),
      addFetchCounts(t.db, [{ orgId, fetches: 2 }]),
    ]);
    await addFetchCounts(t.db, [
      { orgId, fetches: 0 },
      { orgId, fetches: -5 },
    ]);

    const usage = await currentUsage(t.db, orgId);
    expect(usage.secretFetches).toBe(42);
    const rows = await t.pg.query(`select 1 from org_usage_counters where org_id = $1`, [orgId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('counts a Free organisation by the calendar month, in UTC', async () => {
    const { orgId } = await seedOrg();
    await addFetchCounts(t.db, [{ orgId, fetches: 1 }]);
    const usage = await currentUsage(t.db, orgId);
    const now = new Date();
    expect(usage.periodStart.toISOString()).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
  });

  it('counts a paid organisation by its billing period, and a stale period by the month', async () => {
    const periodStart = new Date(Date.now() - 5 * DAY);
    const current = await seedOrg({
      plan: 'team',
      periodStart,
      periodEnd: new Date(Date.now() + 25 * DAY),
    });
    await addFetchCounts(t.db, [{ orgId: current.orgId, fetches: 3 }]);
    expect((await currentUsage(t.db, current.orgId)).periodStart.getTime()).toBe(
      periodStart.getTime(),
    );

    // A renewal webhook that never came: the period ended yesterday. Fetches
    // must not keep collecting against it.
    const stale = await seedOrg({
      plan: 'team',
      periodStart: new Date(Date.now() - 40 * DAY),
      periodEnd: new Date(Date.now() - DAY),
    });
    await addFetchCounts(t.db, [{ orgId: stale.orgId, fetches: 3 }]);
    const now = new Date();
    expect((await currentUsage(t.db, stale.orgId)).periodStart.toISOString()).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
  });

  it('records units sent monotonically — two flushes of the same units are one', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    const period = new Date(Date.UTC(2026, 9, 1));
    await markMeteredUnitsSent(t.db, orgId, period, 10);
    await markMeteredUnitsSent(t.db, orgId, period, 10);
    await markMeteredUnitsSent(t.db, orgId, period, 7);
    await markMeteredUnitsSent(t.db, orgId, period, 0);

    const result = await t.pg.query<{ metered_units_sent: string }>(
      `select metered_units_sent from org_usage_counters where org_id = $1 and period_start = $2`,
      [orgId, period],
    );
    expect(Number(result.rows[0]!.metered_units_sent)).toBe(10);
  });

  it('meters only subscriptions the provider bills, and never a trial', async () => {
    const billed = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
    });
    const trial = await seedOrg({
      plan: 'team',
      status: 'trialing',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
    });
    const manual = await seedOrg({ plan: 'team' });
    const free = await seedOrg();
    for (const { orgId } of [billed, trial, manual, free]) {
      await addFetchCounts(t.db, [{ orgId, fetches: 5 }]);
    }

    const work = await listMeterableUsage(t.db, {
      since: new Date(Date.now() - DAY),
      limit: 1000,
    });
    const orgIds = new Set(work.map((row) => row.orgId));
    expect(orgIds.has(billed.orgId)).toBe(true);
    expect(orgIds.has(trial.orgId)).toBe(false);
    expect(orgIds.has(manual.orgId)).toBe(false);
    expect(orgIds.has(free.orgId)).toBe(false);
  });
});

describe('subscription sweeps', () => {
  it('finds cancellations whose paid period is over, by the database clock', async () => {
    const ended = await seedOrg({
      plan: 'team',
      dodoSubscription: `sub_${uniq()}`,
      cancelAtPeriodEnd: true,
      periodEnd: new Date(Date.now() - 60_000),
    });
    const running = await seedOrg({
      plan: 'team',
      dodoSubscription: `sub_${uniq()}`,
      cancelAtPeriodEnd: true,
      periodEnd: new Date(Date.now() + DAY),
    });

    const found = new Set((await listEndedCancellations(t.db, 1000)).map((row) => row.orgId));
    expect(found.has(ended.orgId)).toBe(true);
    expect(found.has(running.orgId)).toBe(false);
  });

  it('lists provider subscriptions on a paid plan, paged by organisation', async () => {
    const paid = await seedOrg({ plan: 'pro', dodoSubscription: `sub_${uniq()}` });
    const lapsed = await seedOrg({ dodoSubscription: `sub_${uniq()}` });

    const all = await listProviderSubscriptions(t.db, { limit: 1000 });
    expect(all.some((row) => row.orgId === paid.orgId)).toBe(true);
    expect(all.some((row) => row.orgId === lapsed.orgId)).toBe(false);

    const first = await listProviderSubscriptions(t.db, { limit: 1 });
    const second = await listProviderSubscriptions(t.db, {
      limit: 1,
      afterOrgId: first[0]!.orgId,
    });
    if (second[0]) expect(second[0].orgId > first[0]!.orgId).toBe(true);
  });
});

describe('ledgers', () => {
  it('records a checkout once, by session id', async () => {
    const { orgId, ownerId } = await seedOrg();
    const sessionId = `cks_${uniq()}`;
    const checkout = {
      sessionId,
      orgId,
      plan: 'team' as const,
      billingInterval: 'yearly' as const,
      quantity: 3,
      createdBy: ownerId,
    };
    await recordCheckout(t.db, checkout);
    await recordCheckout(t.db, { ...checkout, quantity: 9 });
    expect(await findCheckout(t.db, sessionId)).toMatchObject({ orgId, quantity: 3 });
  });

  it('sends a reminder once per occasion', async () => {
    const { orgId } = await seedOrg();
    const reminder = { orgId, kind: 'trial_ending_3d' as const, occasion: '2026-11-01' };
    expect(await claimReminder(t.db, reminder)).toBe(true);
    expect(await claimReminder(t.db, reminder)).toBe(false);
    expect(await claimReminder(t.db, { ...reminder, occasion: '2026-12-01' })).toBe(true);
    expect(
      await reminderSentSince(t.db, orgId, 'trial_ending_3d', new Date(Date.now() - 60_000)),
    ).toBe(true);
    expect(await reminderSentSince(t.db, orgId, 'payment_failed', new Date(0))).toBe(false);
  });

  it('records a licence key once', async () => {
    const licence = {
      licenseKeyId: `lic_${uniq()}`,
      productId: 'pdt_selfhost_50',
      dodoCustomerId: null,
      dodoSubscriptionId: null,
      dodoPaymentId: null,
      activationsLimit: 3,
      expiresAt: null,
      issuedAt: new Date(),
    };
    expect(await recordLicenseKey(t.db, licence)).toBe(true);
    expect(await recordLicenseKey(t.db, licence)).toBe(false);
  });
});
