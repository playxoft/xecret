import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FREE_SEAT_LIMIT } from '@xecret/core/entitlements';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  addFetchCounts,
  billingCounts,
  claimBillingAlert,
  claimBillingRequest,
  claimReminder,
  claimSeatSync,
  clearSeatSync,
  completeBillingRequest,
  completeSeatSync,
  consumeCheckout,
  countOrgsWithDodoCustomer,
  currentUsage,
  deadLetterSeatSync,
  deferSeatSync,
  detachFromProvider,
  ensureSeatSync,
  failSeatSync,
  findCheckout,
  findOpenCheckout,
  findOrgIdByDodoCustomer,
  findOrgIdByDodoSubscription,
  listDueSeatSyncs,
  listEndedCancellations,
  listLapsedTrials,
  listLongHolds,
  listMeterableUsage,
  listOwnerRecipients,
  listProviderSubscriptions,
  listSeatSyncs,
  liveOrganizationExists,
  lockSubscription,
  markMeteredUnitsSent,
  operatorBillingEdit,
  pruneBillingRequests,
  queueSeatSync,
  raiseCurrentUsageAllowance,
  recordCheckout,
  recordLicenseKey,
  releaseBillingRequest,
  releaseSeatSync,
  reminderSentSince,
  seatedMemberCount,
  seatSyncGeneration,
  writeSubscriptionState,
} from './billing';
import { addMember as addOrgMember, removeMember } from './membership';
import { entitlementsFromRow } from './subscriptions';

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
    meteredFrom?: Date | null;
    trialEndsAt?: Date | null;
    mode?: string | null;
    onHoldSince?: Date | null;
    /** The product a snapshot recorded — by default one for a paid row with a subscription. */
    product?: string | null;
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
        current_period_start, current_period_end, cancel_at_period_end, metered_from,
        trial_ends_at, dodo_mode, on_hold_since, dodo_product_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
      subscription.meteredFrom ?? null,
      subscription.trialEndsAt ?? null,
      subscription.mode ?? null,
      subscription.onHoldSince ?? null,
      subscription.product !== undefined
        ? subscription.product
        : plan !== 'free' && subscription.dodoSubscription
          ? 'pdt_seeded'
          : null,
    ],
  );
  await addMember(orgId, ownerId, 'owner');
  return { orgId, ownerId };
}

async function debtOf(orgId: string) {
  return (await listSeatSyncs(t.db, 10_000)).find((row) => row.orgId === orgId) ?? null;
}

/**
 * Fetches a usage row directly, for a period this test chose — with the
 * allowance its month opened with: the plan's own, unless one is given.
 */
async function seedUsage(
  orgId: string,
  periodStart: Date,
  fetches: number,
  unitsSent = 0,
  included?: number,
): Promise<void> {
  await t.pg.query(
    `insert into org_usage_counters
       (org_id, period_start, secret_fetches, metered_units_sent, included_fetches)
     values ($1, $2, $3, $4, coalesce($5::bigint, (
       select case plan when 'pro' then 200000 when 'team' then 1000000
                        when 'enterprise' then 10000000 else 20000 end
         from org_subscriptions where org_id = $1)))`,
    [orgId, periodStart, fetches, unitsSent, included ?? null],
  );
}

async function allowanceOf(orgId: string, periodStart: Date): Promise<number | null> {
  const result = await t.pg.query<{ included_fetches: string | null }>(
    `select included_fetches from org_usage_counters where org_id = $1 and period_start = $2`,
    [orgId, periodStart],
  );
  const value = result.rows[0]?.included_fetches;
  return value === null || value === undefined ? null : Number(value);
}

async function usageRows(orgId: string): Promise<{ period: string; fetches: number }[]> {
  const result = await t.pg.query<{ period_start: Date; secret_fetches: string }>(
    `select period_start, secret_fetches from org_usage_counters where org_id = $1
      order by period_start`,
    [orgId],
  );
  return result.rows.map((row) => ({
    period: new Date(row.period_start).toISOString(),
    fetches: Number(row.secret_fetches),
  }));
}

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

/** The start of the anniversary month of a yearly period begun at `anchor` that `at` is in. */
function anniversaryMonthOf(anchor: Date, at: Date): Date {
  let months = 0;
  while (plusMonthsUtc(anchor, months + 1).getTime() <= at.getTime()) months += 1;
  return plusMonthsUtc(anchor, months);
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

describe('migration 0025', () => {
  it('adds the provider bookkeeping columns to org_subscriptions, nullable', async () => {
    const result = await t.pg.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'org_subscriptions'
          and column_name in ('metered_from', 'dodo_mode', 'dodo_event_id', 'on_hold_since',
                              'dodo_scheduled_change_at', 'dodo_currency', 'dodo_billing_country')
        order by column_name`,
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'dodo_billing_country',
      'dodo_currency',
      'dodo_event_id',
      'dodo_mode',
      'dodo_scheduled_change_at',
      'metered_from',
      'on_hold_since',
    ]);
    expect(result.rows.every((row) => row.is_nullable === 'YES')).toBe(true);
  });

  it('refuses a Dodo mode that is not one', async () => {
    const { orgId } = await seedOrg();
    await expect(
      t.pg.query(`update org_subscriptions set dodo_mode = 'sandbox' where org_id = $1`, [orgId]),
    ).rejects.toThrow(/org_subscriptions_dodo_mode_check/);
  });

  it('accepts the unpaid-ending reminder, and still nothing it does not define', async () => {
    const { orgId } = await seedOrg();
    expect(await claimReminder(t.db, { orgId, kind: 'plan_ended_unpaid', occasion: 'x' })).toBe(
      true,
    );
  });

  it('refuses an idempotency key that is not one', async () => {
    const { orgId } = await seedOrg();
    await expect(
      t.pg.query(
        `insert into billing_requests (org_id, kind, idempotency_key, fingerprint)
         values ($1, 'checkout', 'short', 'team:yearly')`,
        [orgId],
      ),
    ).rejects.toThrow(/billing_requests_key_check/);
  });
});

describe('migration 0026', () => {
  it('backfills each existing month with the allowance its organisation’s plan includes', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../migrations/0026_usage_month_allowance.sql', import.meta.url)),
      'utf8',
    );
    const backfill = source
      .split('--> statement-breakpoint')
      .map((statement) =>
        statement
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .find((statement) => statement.startsWith('UPDATE'));
    expect(backfill).toBeDefined();

    const month = new Date(Date.UTC(2026, 6, 1));
    const seeded: { orgId: string; expected: number }[] = [];
    for (const [plan, overrides, expected] of [
      ['free', null, 20_000],
      ['pro', null, 200_000],
      ['team', null, 1_000_000],
      ['scale', null, 1_000_000],
      ['enterprise', null, 10_000_000],
      ['pro', { includedFetchesPerMonth: 750_000 }, 750_000],
      ['team', { includedFetchesPerMonth: 5 }, 1_000_000],
    ] as const) {
      const { orgId } = await seedOrg({ plan });
      await t.pg.query(`update org_subscriptions set limit_overrides = $2 where org_id = $1`, [
        orgId,
        overrides === null ? null : JSON.stringify(overrides),
      ]);
      // A month written before the column existed.
      await t.pg.query(
        `insert into org_usage_counters (org_id, period_start, secret_fetches) values ($1, $2, 1)`,
        [orgId, month],
      );
      seeded.push({ orgId, expected });
    }
    const written = await seedOrg({ plan: 'pro' });
    await seedUsage(written.orgId, month, 1, 0, 123_456);

    await t.pg.exec(backfill!);

    for (const { orgId, expected } of seeded) {
      expect(await allowanceOf(orgId, month)).toBe(expected);
    }
    // A month that already records one keeps it.
    expect(await allowanceOf(written.orgId, month)).toBe(123_456);
  });
});

describe('migration 0027', () => {
  it('raises each once-only alert once per occasion, beside the reminders, and nothing undefined', async () => {
    const { orgId } = await seedOrg();
    for (const kind of [
      'alert_unknown_product',
      'alert_activation_waiting',
      'alert_operator_managed',
    ] as const) {
      expect(await claimBillingAlert(t.db, { orgId, kind, occasion: 'sub_1' })).toBe(true);
      expect(await claimBillingAlert(t.db, { orgId, kind, occasion: 'sub_1' })).toBe(false);
      // Another subscription is another occasion.
      expect(await claimBillingAlert(t.db, { orgId, kind, occasion: 'sub_2' })).toBe(true);
    }
    // The emails are untouched by it.
    expect(await claimReminder(t.db, { orgId, kind: 'usage_80', occasion: 'sub_1' })).toBe(true);
    await expect(
      t.pg.query(
        `insert into billing_reminders (org_id, kind, occasion) values ($1, 'alert_promo', 'x')`,
        [orgId],
      ),
    ).rejects.toThrow(/billing_reminders_kind_check/);
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
  it('is one row per organisation, and every queue is a new generation', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    await queueSeatSync(t.db, orgId);
    await queueSeatSync(t.db, orgId);
    const debts = (await listSeatSyncs(t.db, 10_000)).filter((row) => row.orgId === orgId);
    expect(debts).toHaveLength(1);
    expect(debts[0]!.generation).toBe(2);
  });

  it('is paid only under the generation the push counted — a change mid-push survives it', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    await queueSeatSync(t.db, orgId);
    const counted = await claimSeatSync(t.db, orgId, 60_000);
    expect(counted).toBe(1);

    // A member joins while the push is at Dodo.
    await queueSeatSync(t.db, orgId);
    expect(await completeSeatSync(t.db, orgId, counted!)).toBe(false);
    expect(await debtOf(orgId)).not.toBeNull();

    expect(await completeSeatSync(t.db, orgId, (await seatSyncGeneration(t.db, orgId))!)).toBe(
      true,
    );
    expect(await debtOf(orgId)).toBeNull();
  });

  it('allows one push in flight per organisation, until the lease is released or runs out', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    await ensureSeatSync(t.db, orgId);
    expect(await claimSeatSync(t.db, orgId, 60_000)).not.toBeNull();
    expect(await claimSeatSync(t.db, orgId, 60_000)).toBeNull();
    await releaseSeatSync(t.db, orgId);
    expect(await claimSeatSync(t.db, orgId, -1)).not.toBeNull(); // a lease already over
    expect(await claimSeatSync(t.db, orgId, 60_000)).not.toBeNull();
    // No debt, nothing to claim.
    expect(await claimSeatSync(t.db, (await seedOrg()).orgId, 60_000)).toBeNull();
  });

  it('backs off after each failure, and a retry never resets the backoff', async () => {
    const { orgId } = await seedOrg({ plan: 'team' });
    await ensureSeatSync(t.db, orgId);
    expect(await failSeatSync(t.db, orgId, 'upstream_5xx')).toBe(1);
    expect(await failSeatSync(t.db, orgId, 'timeout')).toBe(2);
    await ensureSeatSync(t.db, orgId);

    const debt = await debtOf(orgId);
    expect(debt).toMatchObject({ attempts: 2, lastError: 'timeout', claimedUntil: null });
    // Two failures: four minutes.
    const wait = debt!.notBefore!.getTime() - debt!.lastAttemptAt!.getTime();
    expect(wait).toBeGreaterThanOrEqual(4 * 60_000 - 1000);
    expect(wait).toBeLessThanOrEqual(4 * 60_000 + 1000);
  });

  it('lists only what is due — so stuck debts cannot starve a new one', async () => {
    const now = new Date();
    const backingOff = (await seedOrg({ plan: 'team' })).orgId;
    const deferred = (await seedOrg({ plan: 'team' })).orgId;
    const claimed = (await seedOrg({ plan: 'team' })).orgId;
    const dead = (await seedOrg({ plan: 'team' })).orgId;
    const fresh = (await seedOrg({ plan: 'team' })).orgId;
    for (const orgId of [backingOff, deferred, claimed, dead]) await ensureSeatSync(t.db, orgId);
    await failSeatSync(t.db, backingOff, 'upstream_5xx');
    await deferSeatSync(t.db, deferred, new Date(now.getTime() + 60 * 60_000), 'scheduled_change');
    await claimSeatSync(t.db, claimed, 60_000);
    expect(await deadLetterSeatSync(t.db, dead)).toBe(true);
    expect(await deadLetterSeatSync(t.db, dead)).toBe(false); // raised once
    await ensureSeatSync(t.db, fresh);

    const due = new Set((await listDueSeatSyncs(t.db, now, 10_000)).map((row) => row.orgId));
    expect(due.has(fresh)).toBe(true);
    for (const orgId of [backingOff, deferred, claimed, dead]) expect(due.has(orgId)).toBe(false);

    // A new membership change makes even a dead-lettered debt due again.
    await queueSeatSync(t.db, dead);
    expect(
      (await listDueSeatSyncs(t.db, new Date(), 10_000)).some((row) => row.orgId === dead),
    ).toBe(true);
  });

  it('commits with the membership change itself, for an organisation Dodo bills — and only then', async () => {
    const billed = await seedOrg({ plan: 'team', dodoSubscription: `sub_${uniq()}` });
    const free = await seedOrg();
    const manual = await seedOrg({ plan: 'enterprise', interval: 'yearly' });

    for (const org of [billed, free, manual]) {
      // Seeded first: PGlite runs one transaction at a time, so a fixture query
      // from inside one would wait on it for ever.
      const userId = await seedUser();
      await t.db.transaction(async (tx) => {
        await addOrgMember(tx, {
          orgId: org.orgId,
          userId,
          role: 'developer',
          invitedBy: org.ownerId,
        });
      });
    }
    expect(await debtOf(billed.orgId)).not.toBeNull();
    expect(await debtOf(free.orgId)).toBeNull();
    expect(await debtOf(manual.orgId)).toBeNull();

    // A membership change that rolls back leaves no debt behind.
    const other = await seedOrg({ plan: 'team', dodoSubscription: `sub_${uniq()}` });
    const joiner = await seedUser();
    await expect(
      t.db.transaction(async (tx) => {
        await addOrgMember(tx, {
          orgId: other.orgId,
          userId: joiner,
          role: 'developer',
          invitedBy: other.ownerId,
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await debtOf(other.orgId)).toBeNull();
  });

  it('is written by a removal too, under its own transaction', async () => {
    const billed = await seedOrg({ plan: 'team', dodoSubscription: `sub_${uniq()}` });
    const userId = await seedUser();
    const member = await addOrgMember(t.db, {
      orgId: billed.orgId,
      userId,
      role: 'developer',
      invitedBy: billed.ownerId,
    });
    await clearSeatSync(t.db, billed.orgId);

    await removeMember(t.db, { orgId: billed.orgId, memberId: member.id }, null);
    expect(await debtOf(billed.orgId)).not.toBeNull();
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

  /** Past Team's allowance by a few units, so a row the meter may list. */
  const OVER_TEAM = 1_000_000 + 5_000;

  it('meters only subscriptions the provider bills, and never a trial', async () => {
    const periodStart = new Date(Date.now() - 5 * DAY);
    const billing = {
      plan: 'team',
      periodStart,
      periodEnd: new Date(Date.now() + 25 * DAY),
      meteredFrom: periodStart,
    };
    const billed = await seedOrg({
      ...billing,
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
    });
    const trial = await seedOrg({
      ...billing,
      status: 'trialing',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
    });
    const manual = await seedOrg(billing);
    const free = await seedOrg();
    for (const { orgId } of [billed, trial, manual, free]) {
      await addFetchCounts(t.db, [{ orgId, fetches: OVER_TEAM }]);
    }

    const work = await listMeterableUsage(t.db, {
      since: new Date(Date.now() - DAY),
      limit: 1000,
      mode: 'test_mode',
    });
    const orgIds = new Set(work.map((row) => row.orgId));
    expect(orgIds.has(billed.orgId)).toBe(true);
    expect(orgIds.has(trial.orgId)).toBe(false);
    expect(orgIds.has(manual.orgId)).toBe(false);
    expect(orgIds.has(free.orgId)).toBe(false);
  });

  it('never meters a period from before the subscription — Free usage, then an upgrade', async () => {
    // Heavy use on Free in the calendar month, then a Team checkout on the 10th.
    const now = Date.now();
    const freeMonth = new Date(Date.UTC(2026, 8, 1));
    const activated = new Date(Date.UTC(2026, 8, 10));
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      periodStart: activated,
      periodEnd: new Date(now + 20 * DAY),
      meteredFrom: activated,
    });
    await seedUsage(orgId, freeMonth, 50 * OVER_TEAM);
    await seedUsage(orgId, activated, OVER_TEAM);

    const work = (
      await listMeterableUsage(t.db, { since: new Date(0), limit: 1000, mode: 'test_mode' })
    ).filter((row) => row.orgId === orgId);
    expect(work.map((row) => row.periodStart.toISOString())).toEqual([activated.toISOString()]);
  });

  it('never meters a trial’s period once the trial converts', async () => {
    const created = new Date(Date.UTC(2026, 8, 1));
    const trialEnd = new Date(Date.UTC(2026, 8, 15));
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      periodStart: trialEnd,
      periodEnd: new Date(Date.now() + 20 * DAY),
      trialEndsAt: trialEnd,
      meteredFrom: trialEnd,
    });
    await seedUsage(orgId, created, 40 * OVER_TEAM); // the trial's period
    await seedUsage(orgId, trialEnd, OVER_TEAM);

    const work = (
      await listMeterableUsage(t.db, { since: new Date(0), limit: 1000, mode: 'test_mode' })
    ).filter((row) => row.orgId === orgId);
    expect(work.map((row) => row.periodStart.toISOString())).toEqual([trialEnd.toISOString()]);
  });

  it('meters nothing for a subscription with no metered-from recorded', async () => {
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
    });
    await seedUsage(orgId, new Date(Date.UTC(2026, 8, 1)), 9 * OVER_TEAM);
    const work = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'test_mode',
    });
    expect(work.some((row) => row.orgId === orgId)).toBe(false);
  });

  it('leaves out a row from the other Dodo mode', async () => {
    const start = new Date(Date.UTC(2026, 8, 1));
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      meteredFrom: start,
      mode: 'test_mode',
    });
    await seedUsage(orgId, start, OVER_TEAM);
    const live = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'live_mode',
    });
    expect(live.some((row) => row.orgId === orgId)).toBe(false);
    const test = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'test_mode',
    });
    expect(test.some((row) => row.orgId === orgId)).toBe(true);
  });

  it('lists only rows that can owe another unit, and pages past any number of them', async () => {
    const start = new Date(Date.UTC(2026, 7, 1));
    const subscription = (meteredFrom: Date) => ({
      plan: 'pro',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      meteredFrom,
    });
    // Within Pro's allowance, and past it but with every unit already reported.
    const within = await seedOrg(subscription(start));
    await seedUsage(within.orgId, start, 150_000);
    const reported = await seedOrg(subscription(start));
    await seedUsage(reported.orgId, start, 200_000 + 3_500, 3);
    // Twelve that each owe something.
    const owing: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const { orgId } = await seedOrg(subscription(start));
      await seedUsage(orgId, start, 200_000 + 2_000);
      owing.push(orgId);
    }

    const seen: string[] = [];
    let after: { orgId: string; periodStart: Date } | undefined;
    for (;;) {
      const page = await listMeterableUsage(t.db, {
        since: new Date(0),
        limit: 5,
        mode: 'test_mode',
        after,
      });
      seen.push(...page.map((row) => row.orgId));
      if (page.length < 5) break;
      const last = page[page.length - 1]!;
      after = { orgId: last.orgId, periodStart: last.periodStart };
    }
    for (const orgId of owing) expect(seen).toContain(orgId);
    expect(seen).not.toContain(within.orgId);
    expect(seen).not.toContain(reported.orgId);
    expect(new Set(seen).size).toBe(seen.length); // no row twice
  });

  it('puts a fetch in the period it was counted in, not the one it was flushed into', async () => {
    const now = Date.now();
    const previous = new Date(now - 30 * DAY);
    const renewed = new Date(now - 60_000);
    const { orgId } = await seedOrg({
      plan: 'team',
      dodoSubscription: `sub_${uniq()}`,
      periodStart: previous,
      periodEnd: renewed,
    });
    await addFetchCounts(t.db, [{ orgId, fetches: 2, countedAt: new Date(now - 2 * DAY) }]);

    // The renewal webhook lands; then the last fetches of the old period are flushed.
    await t.pg.query(
      `update org_subscriptions set current_period_start = $2, current_period_end = $3 where org_id = $1`,
      [orgId, renewed, new Date(now + 30 * DAY)],
    );
    await addFetchCounts(t.db, [
      { orgId, fetches: 3, countedAt: new Date(renewed.getTime() - 5_000) },
      { orgId, fetches: 4, countedAt: new Date(renewed.getTime() + 5_000) },
    ]);

    expect(await usageRows(orgId)).toEqual([
      { period: previous.toISOString(), fetches: 5 },
      { period: renewed.toISOString(), fetches: 4 },
    ]);
  });

  it('counts a yearly plan month by month, from its billing anniversary', async () => {
    // A year that began on 31 January: its months begin on the 31st where
    // there is one, and on the month's last day where there is not.
    const anchor = new Date(Date.UTC(2026, 0, 31, 10, 0, 0));
    const { orgId } = await seedOrg({
      plan: 'pro',
      interval: 'yearly',
      dodoSubscription: `sub_${uniq()}`,
      periodStart: anchor,
      periodEnd: new Date(Date.now() + 400 * DAY),
    });
    await addFetchCounts(t.db, [
      { orgId, fetches: 1, countedAt: new Date(Date.UTC(2026, 1, 15)) },
      { orgId, fetches: 2, countedAt: new Date(Date.UTC(2026, 1, 28, 10, 0, 0)) },
      { orgId, fetches: 3, countedAt: new Date(Date.UTC(2026, 2, 30, 23, 59)) },
      { orgId, fetches: 4, countedAt: new Date(Date.UTC(2026, 2, 31, 10, 0, 1)) },
    ]);
    expect(await usageRows(orgId)).toEqual([
      { period: anchor.toISOString(), fetches: 1 },
      { period: new Date(Date.UTC(2026, 1, 28, 10)).toISOString(), fetches: 5 },
      { period: new Date(Date.UTC(2026, 2, 31, 10)).toISOString(), fetches: 4 },
    ]);
  });

  it('reads a yearly plan’s usage for the month of the year it is in now', async () => {
    const now = new Date();
    const anchor = new Date(now.getTime() - 70 * DAY);
    const { orgId } = await seedOrg({
      plan: 'pro',
      interval: 'yearly',
      dodoSubscription: `sub_${uniq()}`,
      periodStart: anchor,
      periodEnd: new Date(anchor.getTime() + 365 * DAY),
    });
    // The year's first month was heavy; this month is not.
    await seedUsage(orgId, anchor, 900_000);
    await addFetchCounts(t.db, [{ orgId, fetches: 7 }]);

    const usage = await currentUsage(t.db, orgId);
    expect(usage.periodStart.toISOString()).toBe(anniversaryMonthOf(anchor, now).toISOString());
    expect(usage.periodStart.getTime()).toBeGreaterThan(anchor.getTime());
    expect(usage.secretFetches).toBe(7);
  });

  it('never meters a yearly plan that stays inside its monthly allowance', async () => {
    const anchor = new Date(Date.UTC(2026, 2, 10));
    const { orgId } = await seedOrg({
      plan: 'pro',
      interval: 'yearly',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      periodStart: anchor,
      periodEnd: new Date(Date.now() + 400 * DAY),
      meteredFrom: anchor,
    });
    // 100k a month for three months: 300k in the year, never 200k in a month.
    for (const month of [2, 3, 4]) {
      await addFetchCounts(t.db, [
        { orgId, fetches: 100_000, countedAt: new Date(Date.UTC(2026, month, 20)) },
      ]);
    }
    const work = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'test_mode',
    });
    expect(work.some((row) => row.orgId === orgId)).toBe(false);
  });

  it('records the allowance a month opens with — the plan’s, raised (never lowered) by support', async () => {
    const cases: { plan: string; overrides: Record<string, unknown> | null; expected: number }[] = [
      { plan: 'free', overrides: null, expected: 20_000 },
      { plan: 'pro', overrides: null, expected: 200_000 },
      { plan: 'team', overrides: null, expected: 1_000_000 },
      { plan: 'scale', overrides: null, expected: 1_000_000 },
      { plan: 'enterprise', overrides: null, expected: 10_000_000 },
      { plan: 'pro', overrides: { includedFetchesPerMonth: 500_000 }, expected: 500_000 },
      { plan: 'pro', overrides: { includedFetchesPerMonth: 1_000 }, expected: 200_000 },
      { plan: 'pro', overrides: { includedFetchesPerMonth: null }, expected: 200_000 },
      { plan: 'pro', overrides: { projects: 9_000 }, expected: 200_000 },
    ];
    for (const { plan, overrides, expected } of cases) {
      const { orgId } = await seedOrg({ plan });
      await t.pg.query(`update org_subscriptions set limit_overrides = $2 where org_id = $1`, [
        orgId,
        overrides === null ? null : JSON.stringify(overrides),
      ]);
      await addFetchCounts(t.db, [{ orgId, fetches: 1 }]);
      const recorded = (await currentUsage(t.db, orgId)).includedFetches;
      // The database's figure is the one entitlement resolution reaches.
      const resolved = entitlementsFromRow({
        plan: plan as never,
        status: 'active',
        addonSaml: false,
        addonDirectorySync: false,
        limitOverrides: overrides as never,
        currentPeriodEnd: null,
      }).limits.includedFetchesPerMonth;
      expect({ plan, overrides, recorded, resolved }).toEqual({
        plan,
        overrides,
        recorded: expected,
        resolved: expected,
      });
    }

    // What entitlement resolution ignores, so does the meter; a fraction is
    // rounded up, in the customer's favour.
    for (const [value, expected] of [
      ['900000', 200_000],
      [250_000.5, 250_001],
      [1e30, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const { orgId } = await seedOrg({ plan: 'pro' });
      await t.pg.query(`update org_subscriptions set limit_overrides = $2 where org_id = $1`, [
        orgId,
        JSON.stringify({ includedFetchesPerMonth: value }),
      ]);
      await addFetchCounts(t.db, [{ orgId, fetches: 1 }]);
      expect((await currentUsage(t.db, orgId)).includedFetches).toBe(expected);
    }
  });

  it('keeps an old month’s allowance when the plan moves — a Team month after a downgrade to Pro', async () => {
    const now = Date.now();
    const teamStart = new Date(now - 30 * DAY);
    const renewal = new Date(now - 60_000);
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      periodStart: teamStart,
      periodEnd: renewal,
      meteredFrom: teamStart,
    });
    await addFetchCounts(t.db, [{ orgId, fetches: 1_050_000, countedAt: new Date(now - 2 * DAY) }]);
    expect(await allowanceOf(orgId, teamStart)).toBe(1_000_000);

    // Renewed on Pro: the downgrade took effect at the period end.
    await t.pg.query(
      `update org_subscriptions set plan = 'pro', current_period_start = $2,
              current_period_end = $3 where org_id = $1`,
      [orgId, renewal, new Date(now + 30 * DAY)],
    );
    // The Team month's last fetches, flushed after the renewal.
    await addFetchCounts(t.db, [
      { orgId, fetches: 3, countedAt: new Date(renewal.getTime() - 5_000) },
    ]);
    await addFetchCounts(t.db, [{ orgId, fetches: 4 }]);
    expect(await allowanceOf(orgId, teamStart)).toBe(1_000_000);
    expect(await allowanceOf(orgId, renewal)).toBe(200_000);

    const work = (
      await listMeterableUsage(t.db, { since: new Date(0), limit: 1000, mode: 'test_mode' })
    ).filter((row) => row.orgId === orgId);
    expect(work.map((row) => [row.periodStart.toISOString(), row.includedFetches])).toEqual([
      [teamStart.toISOString(), 1_000_000],
    ]);
  });

  it('raises the current month’s allowance with support, and keeps it after the raise is cleared', async () => {
    const now = Date.now();
    const start = new Date(now - 5 * DAY);
    const { orgId } = await seedOrg({
      plan: 'pro',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      periodStart: start,
      periodEnd: new Date(now + 25 * DAY),
      meteredFrom: start,
    });
    const setOverride = (value: number | null) =>
      t.pg.query(`update org_subscriptions set limit_overrides = $2 where org_id = $1`, [
        orgId,
        value === null ? null : JSON.stringify({ includedFetchesPerMonth: value }),
      ]);
    await addFetchCounts(t.db, [{ orgId, fetches: 10 }]);
    expect(await allowanceOf(orgId, start)).toBe(200_000);

    // Raised mid-month — by the operator tool at once, and by the next flush.
    await setOverride(400_000);
    await raiseCurrentUsageAllowance(t.db, orgId);
    expect(await allowanceOf(orgId, start)).toBe(400_000);
    await setOverride(500_000);
    await addFetchCounts(t.db, [{ orgId, fetches: 10 }]);
    expect(await allowanceOf(orgId, start)).toBe(500_000);

    // Cleared: the month keeps what it was granted, whoever writes next.
    await setOverride(null);
    await raiseCurrentUsageAllowance(t.db, orgId);
    await addFetchCounts(t.db, [{ orgId, fetches: 450_000 }]);
    expect(await allowanceOf(orgId, start)).toBe(500_000);
    const work = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'test_mode',
    });
    expect(work.some((row) => row.orgId === orgId)).toBe(false);
  });

  it('never meters a month with no allowance recorded', async () => {
    const start = new Date(Date.UTC(2026, 8, 1));
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: `cus_${uniq()}`,
      dodoSubscription: `sub_${uniq()}`,
      meteredFrom: start,
    });
    await t.pg.query(
      `insert into org_usage_counters (org_id, period_start, secret_fetches) values ($1, $2, $3)`,
      [orgId, start, 9 * OVER_TEAM],
    );
    const work = await listMeterableUsage(t.db, {
      since: new Date(0),
      limit: 1000,
      mode: 'test_mode',
    });
    expect(work.some((row) => row.orgId === orgId)).toBe(false);
  });

  it('counts a fetch made on Free just before an upgrade into the Free month', async () => {
    const now = Date.now();
    const activated = new Date(now - 60_000);
    const { orgId } = await seedOrg({
      plan: 'team',
      dodoSubscription: `sub_${uniq()}`,
      periodStart: activated,
      periodEnd: new Date(now + 30 * DAY),
    });
    const before = new Date(activated.getTime() - 10_000);
    await addFetchCounts(t.db, [{ orgId, fetches: 7, countedAt: before }]);
    const month = new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), 1));
    expect(await usageRows(orgId)).toEqual([{ period: month.toISOString(), fetches: 7 }]);
  });
});

describe('detachFromProvider (plan:set over a Dodo subscription)', () => {
  it('clears every provider id and leaves the row reading as an operator’s grant', async () => {
    const subscriptionId = `sub_${uniq()}`;
    const customerId = `cus_${uniq()}`;
    const { orgId } = await seedOrg({
      plan: 'team',
      customer: customerId,
      dodoSubscription: subscriptionId,
      meteredFrom: new Date(),
      mode: 'live_mode',
    });
    await ensureSeatSync(t.db, orgId);

    const detached = await t.db.transaction(async (tx) => {
      const ids = await detachFromProvider(tx, orgId);
      await writeSubscriptionState(tx, orgId, { plan: 'enterprise', billingInterval: 'yearly' });
      return ids;
    });
    // The run's own record of which subscription it was, to cancel at Dodo.
    expect(detached).toEqual({ dodoSubscriptionId: subscriptionId, dodoCustomerId: customerId });

    const row = await t.db.transaction((tx) => lockSubscription(tx, orgId));
    expect(row).toMatchObject({
      plan: 'enterprise',
      dodoSubscriptionId: null,
      dodoCustomerId: null,
      dodoProductId: null,
      dodoMode: null,
      meteredFrom: null,
    });
    // Managed by support now — a paid plan with no subscription — and found by
    // nothing that looks for the provider's ids.
    expect(row!.plan !== 'free' && row!.dodoSubscriptionId === null).toBe(true);
    expect(await findOrgIdByDodoSubscription(t.db, subscriptionId)).toBeNull();
    expect(await countOrgsWithDodoCustomer(t.db, customerId)).toBe(0);
    expect(await debtOf(orgId)).toBeNull();
    expect(
      (await listProviderSubscriptions(t.db, { limit: 10_000 })).some((r) => r.orgId === orgId),
    ).toBe(false);
  });

  it('answers null for a row that followed no subscription', async () => {
    const { orgId } = await seedOrg({ plan: 'enterprise', interval: 'yearly' });
    expect(await t.db.transaction((tx) => detachFromProvider(tx, orgId))).toBeNull();
  });

  it('takes a Free row off the subscription it ended on, too', async () => {
    // Ended (here, or by Dodo): Free, but the ids kept so Dodo's events still find it.
    const subscriptionId = `sub_${uniq()}`;
    const { orgId } = await seedOrg({
      customer: `cus_${uniq()}`,
      dodoSubscription: subscriptionId,
      mode: 'test_mode',
    });
    await t.pg.query(`update org_subscriptions set dodo_event_at = now() where org_id = $1`, [
      orgId,
    ]);
    await ensureSeatSync(t.db, orgId);

    const detached = await t.db.transaction(async (tx) => {
      const ids = await detachFromProvider(tx, orgId);
      await writeSubscriptionState(tx, orgId, { plan: 'team', billingInterval: 'yearly' });
      return ids;
    });
    expect(detached?.dodoSubscriptionId).toBe(subscriptionId);
    const row = await t.db.transaction((tx) => lockSubscription(tx, orgId));
    expect(row).toMatchObject({
      plan: 'team',
      dodoSubscriptionId: null,
      dodoCustomerId: null,
      dodoMode: null,
      dodoEventAt: null,
    });
    expect(await findOrgIdByDodoSubscription(t.db, subscriptionId)).toBeNull();
    expect(await debtOf(orgId)).toBeNull();
  });
});

describe('operatorBillingEdit (plan:set’s rule)', () => {
  const none = {
    dodoSubscriptionId: null,
    dodoCustomerId: null,
    dodoProductId: null,
    dodoMode: null,
    dodoEventAt: null,
    dodoEventId: null,
    dodoScheduledChangeAt: null,
  };
  const billing = { touchesBilling: true, overDodo: false };

  it('refuses a billing change over a subscription Dodo bills, unless told --over-dodo', () => {
    const billed = {
      ...none,
      plan: 'team' as const,
      dodoSubscriptionId: 'sub_1',
      dodoCustomerId: 'cus_1',
      dodoProductId: 'pdt_team_m',
    };
    expect(operatorBillingEdit(billed, billing)).toBe('refuse');
    expect(operatorBillingEdit(billed, { ...billing, overDodo: true })).toBe('detach');
  });

  it('detaches a Free row that kept an ended subscription’s ids, whatever plan is granted', () => {
    const endedHere = {
      ...none,
      plan: 'free' as const,
      dodoSubscriptionId: 'sub_1',
      dodoCustomerId: 'cus_1',
      dodoMode: 'test_mode' as const,
      dodoEventAt: new Date(),
    };
    expect(operatorBillingEdit(endedHere, billing)).toBe('detach');
    // A customer id alone is still a provider's: a checkout would reuse it.
    expect(operatorBillingEdit({ ...none, plan: 'free', dodoCustomerId: 'cus_1' }, billing)).toBe(
      'detach',
    );
  });

  it('writes a row that carries nothing of a provider, and any add-on or override', () => {
    expect(operatorBillingEdit({ ...none, plan: 'free' }, billing)).toBe('write');
    expect(operatorBillingEdit({ ...none, plan: 'enterprise' }, billing)).toBe('write');
    expect(
      operatorBillingEdit(
        { ...none, plan: 'team', dodoSubscriptionId: 'sub_1', dodoProductId: 'pdt_team_m' },
        { touchesBilling: false, overDodo: false },
      ),
    ).toBe('write');
  });
});

describe('subscription sweeps', () => {
  it('finds subscriptions on hold since before a cut-off, and stale trials', async () => {
    const now = Date.now();
    const long = await seedOrg({
      plan: 'team',
      status: 'on_hold',
      dodoSubscription: `sub_${uniq()}`,
      onHoldSince: new Date(now - 15 * DAY),
    });
    const recent = await seedOrg({
      plan: 'team',
      status: 'on_hold',
      dodoSubscription: `sub_${uniq()}`,
      onHoldSince: new Date(now - 2 * DAY),
    });
    const holds = new Set(
      (await listLongHolds(t.db, { since: new Date(now - 14 * DAY), limit: 1000 })).map(
        (row) => row.orgId,
      ),
    );
    expect(holds.has(long.orgId)).toBe(true);
    expect(holds.has(recent.orgId)).toBe(false);

    const lapsed = await seedOrg({
      plan: 'team',
      status: 'trialing',
      dodoSubscription: `sub_${uniq()}`,
      trialEndsAt: new Date(now - 5 * 60 * 60_000),
    });
    const running = await seedOrg({
      plan: 'team',
      status: 'trialing',
      dodoSubscription: `sub_${uniq()}`,
      trialEndsAt: new Date(now + DAY),
    });
    const trials = new Set(
      (await listLapsedTrials(t.db, { endedBefore: new Date(now - 60 * 60_000), limit: 1000 })).map(
        (row) => row.orgId,
      ),
    );
    expect(trials.has(lapsed.orgId)).toBe(true);
    expect(trials.has(running.orgId)).toBe(false);
  });

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
      nonce: `nonce_${uniq()}`,
    };
    await recordCheckout(t.db, checkout);
    await recordCheckout(t.db, { ...checkout, quantity: 9 });
    expect(await findCheckout(t.db, sessionId)).toMatchObject({ orgId, quantity: 3 });
  });

  it('opens a checkout to its own organisation’s nonce only, and spends it once', async () => {
    const { orgId, ownerId } = await seedOrg();
    const other = await seedOrg();
    const nonce = `nonce_${uniq()}`;
    const sessionId = `cks_${uniq()}`;
    await recordCheckout(t.db, {
      sessionId,
      orgId,
      plan: 'team',
      billingInterval: 'monthly',
      quantity: 3,
      createdBy: ownerId,
      nonce,
    });
    const openSince = new Date(Date.now() - DAY);

    expect(await findOpenCheckout(t.db, { orgId, nonce, openSince })).toMatchObject({ sessionId });
    // Another organisation's id beside this nonce, or a nonce nobody minted: nothing.
    expect(await findOpenCheckout(t.db, { orgId: other.orgId, nonce, openSince })).toBeNull();
    expect(await findOpenCheckout(t.db, { orgId, nonce: `nonce_${uniq()}`, openSince })).toBeNull();
    // Too old to be open.
    expect(
      await findOpenCheckout(t.db, { orgId, nonce, openSince: new Date(Date.now() + 1000) }),
    ).toBeNull();

    expect(
      await consumeCheckout(t.db, { orgId: other.orgId, subscriptionId: 'sub_x', by: { nonce } }),
    ).toBe(false);
    expect(await consumeCheckout(t.db, { orgId, subscriptionId: 'sub_a', by: { nonce } })).toBe(
      true,
    );
    // Spent: neither another subscription nor the same one again.
    expect(await consumeCheckout(t.db, { orgId, subscriptionId: 'sub_b', by: { sessionId } })).toBe(
      false,
    );
    expect(await consumeCheckout(t.db, { orgId, subscriptionId: 'sub_a', by: { nonce } })).toBe(
      false,
    );
    expect(await findOpenCheckout(t.db, { orgId, nonce, openSince })).toBeNull();
    expect(await findCheckout(t.db, sessionId)).toMatchObject({ subscriptionId: 'sub_a' });
  });

  it('refuses a nonce minted twice', async () => {
    const { orgId, ownerId } = await seedOrg();
    const nonce = `nonce_${uniq()}`;
    const base = {
      orgId,
      plan: 'team' as const,
      billingInterval: 'monthly' as const,
      quantity: 3,
      createdBy: ownerId,
      nonce,
    };
    await recordCheckout(t.db, { ...base, sessionId: `cks_${uniq()}` });
    await expect(recordCheckout(t.db, { ...base, sessionId: `cks_${uniq()}` })).rejects.toThrow();
  });

  it('answers a repeated idempotency key with the first answer, and refuses it for another request', async () => {
    const { orgId } = await seedOrg();
    const key = randomUUID();
    const request = { orgId, kind: 'checkout' as const, key, fingerprint: 'team:yearly' };

    expect(await claimBillingRequest(t.db, request)).toEqual({ state: 'claimed' });
    expect(await claimBillingRequest(t.db, request)).toEqual({ state: 'in-flight' });
    await completeBillingRequest(t.db, { ...request, result: { url: 'https://pay.example/1' } });
    expect(await claimBillingRequest(t.db, request)).toEqual({
      state: 'replay',
      result: { url: 'https://pay.example/1' },
    });
    expect(await claimBillingRequest(t.db, { ...request, fingerprint: 'pro:monthly' })).toEqual({
      state: 'mismatch',
    });
    // The same key for the other kind is a separate request.
    expect(await claimBillingRequest(t.db, { ...request, kind: 'change' })).toEqual({
      state: 'claimed',
    });

    // A failed request lets go of its key; a finished one keeps its answer.
    await releaseBillingRequest(t.db, { orgId, kind: 'change', key });
    expect(await claimBillingRequest(t.db, { ...request, kind: 'change' })).toEqual({
      state: 'claimed',
    });
    await releaseBillingRequest(t.db, { orgId, kind: 'checkout', key });
    expect((await claimBillingRequest(t.db, request)).state).toBe('replay');

    await pruneBillingRequests(t.db, new Date(Date.now() + 1000));
    expect(await claimBillingRequest(t.db, request)).toEqual({ state: 'claimed' });
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
