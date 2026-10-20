import { and, asc, count, eq, gt, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { BillingInterval, PlanId } from '@xecret/core/entitlements';
import {
  billingCheckouts,
  billingLicenseKeys,
  billingReminders,
  billingSeatSyncs,
  orgSubscriptions,
  orgUsageCounters,
} from '../schema/billing';
import type { BillingReminderKind } from '../schema/billing';
import { users } from '../schema/identity';
import { projects } from '../schema/resources';
import { invitations, orgMembers, organizations } from '../schema/tenancy';
import { serviceTokens } from '../schema/tokens';
import type { Executor, Transaction } from './shared';
import type { SubscriptionPatch, SubscriptionRecord } from './subscriptions';

/**
 * The payment side of `org_subscriptions`, and the four ledgers beside it (P12).
 *
 * ── The rule this file shares with `subscriptions.ts` ──
 * Nothing here reads the payment provider, and nothing here is on the
 * secret-fetch path. These functions are called by the webhook, the billing
 * routes and the scheduled jobs — all of them already doing IO, none of them
 * latency-sensitive — and by `addFetchCounts`, which is the destination of an
 * off-path flush and never of a fetch itself.
 *
 * ── Who decides ──
 * These write what they are told. What the subscription *should* say is
 * decided by the webhook's snapshot logic in `apps/web/src/server/billing`,
 * and what it costs by the payment provider. A repository that decided either
 * would be a second copy of a rule that must have one.
 */

/* ── subscription rows ─────────────────────────────────────────────────────── */

/**
 * The organisation's subscription row, locked for the rest of the transaction.
 *
 * Every webhook that writes a subscription takes this first, so two events for
 * one organisation — an `active` and a `payment.succeeded` delivered in the
 * same second — apply one after the other rather than each reading the row the
 * other is about to change. The lock is the row's, not the organisation's: the
 * membership transactions that take `organizations … FOR UPDATE` are not
 * blocked by a webhook, and a webhook never waits on an invitation.
 */
export async function lockSubscription(
  tx: Transaction,
  orgId: string,
): Promise<SubscriptionRecord | null> {
  const [row] = await tx
    .select()
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** The organisation a provider subscription id belongs to, if we know it. */
export async function findOrgIdByDodoSubscription(
  exec: Executor,
  dodoSubscriptionId: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ orgId: orgSubscriptions.orgId })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.dodoSubscriptionId, dodoSubscriptionId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * The organisation a provider customer id belongs to — **only when exactly one
 * does**.
 *
 * A customer at the payment provider is an email address, and one person can
 * own two organisations that each bought a plan. An event that can only be
 * placed by its customer is therefore placed only when the answer is
 * unambiguous; two matches answer `null`, and the caller does not guess.
 */
export async function findOrgIdByDodoCustomer(
  exec: Executor,
  dodoCustomerId: string,
): Promise<string | null> {
  const rows = await exec
    .select({ orgId: orgSubscriptions.orgId })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.dodoCustomerId, dodoCustomerId))
    .limit(2);
  return rows.length === 1 ? (rows[0]?.orgId ?? null) : null;
}

/** Whether a live organisation has this id. Metadata names one; this checks it is real. */
export async function liveOrganizationExists(exec: Executor, orgId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** The organisation's name and slug, for an email or a log line. */
export async function findBillingOrganization(
  exec: Executor,
  orgId: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const [row] = await exec
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Writes a subscription change and, when given, the seat pair with it — in the
 * caller's transaction, so an invoice figure and an access ceiling can never be
 * left disagreeing by a crash between two statements.
 *
 * `seats.billed` is what the provider bills (its `quantity`); `seats.enforced`
 * is what invitations are refused against (`organizations.seat_limit`). See
 * `providerSeats` in `@xecret/core/entitlements` for how the pair is decided.
 */
export async function writeSubscriptionState(
  tx: Transaction,
  orgId: string,
  patch: SubscriptionPatch & {
    currentPeriodStart?: Date | null;
    dodoProductId?: string | null;
    dodoEventAt?: Date | null;
    renewalAmountMinor?: number | null;
  },
  seats?: { billed: number; enforced: number },
): Promise<SubscriptionRecord | null> {
  const now = new Date();
  const [row] = await tx
    .update(orgSubscriptions)
    .set({ ...patch, ...(seats ? { seats: seats.billed } : {}), updatedAt: now })
    .where(eq(orgSubscriptions.orgId, orgId))
    .returning();

  if (seats && row) {
    await tx
      .update(organizations)
      .set({ seatLimit: seats.enforced, updatedAt: now })
      .where(eq(organizations.id, orgId));
  }
  return row ?? null;
}

/**
 * Members holding a seat, **whatever their status** — the number a provider
 * subscription is billed for. Suspension is a security act, never a discount.
 * Pending invitations are not counted: nobody is billed for a seat until the
 * invitation is accepted, as the pricing page says.
 */
export async function seatedMemberCount(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.seatAssigned, true)));
  return row?.value ?? 0;
}

/** Live owners' addresses — who a billing email goes to. Suspended owners get none. */
export async function listOwnerRecipients(
  exec: Executor,
  orgId: string,
): Promise<{ email: string; displayName: string | null }[]> {
  return exec
    .select({ email: users.email, displayName: users.displayName })
    .from(orgMembers)
    .innerJoin(users, and(eq(users.id, orgMembers.userId), isNull(users.deletedAt)))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.role, 'owner'),
        eq(orgMembers.status, 'active'),
      ),
    )
    .orderBy(asc(orgMembers.createdAt))
    .limit(50);
}

/**
 * Every subscription the payment provider manages and we still treat as paid:
 * what the reconciler compares, and what the reminder sweep reads.
 *
 * Bounded per call; the reconciler pages with `afterOrgId`.
 */
export async function listProviderSubscriptions(
  exec: Executor,
  options: { limit: number; afterOrgId?: string | undefined },
): Promise<SubscriptionRecord[]> {
  return exec
    .select({ subscription: orgSubscriptions })
    .from(orgSubscriptions)
    .innerJoin(
      organizations,
      and(eq(organizations.id, orgSubscriptions.orgId), isNull(organizations.deletedAt)),
    )
    .where(
      and(
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        ne(orgSubscriptions.plan, 'free'),
        options.afterOrgId === undefined
          ? undefined
          : gt(orgSubscriptions.orgId, options.afterOrgId),
      ),
    )
    .orderBy(asc(orgSubscriptions.orgId))
    .limit(options.limit)
    .then((rows) => rows.map((row) => row.subscription));
}

/**
 * Cancelled subscriptions whose paid period is over — the boundary the
 * `cancel_at_period_end` flag was waiting for. The hourly job returns each to
 * Free; this only finds them. By the database's clock, not a Worker's.
 */
export async function listEndedCancellations(
  exec: Executor,
  limit: number,
): Promise<SubscriptionRecord[]> {
  return exec
    .select()
    .from(orgSubscriptions)
    .where(
      and(
        eq(orgSubscriptions.cancelAtPeriodEnd, true),
        ne(orgSubscriptions.plan, 'free'),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        lt(orgSubscriptions.currentPeriodEnd, sql`now()`),
      ),
    )
    .orderBy(asc(orgSubscriptions.currentPeriodEnd))
    .limit(limit);
}

/* ── checkouts ─────────────────────────────────────────────────────────────── */

export type CheckoutRecord = typeof billingCheckouts.$inferSelect;

/** Records a hosted checkout the server just created. Insert-only by grant. */
export async function recordCheckout(
  exec: Executor,
  checkout: {
    sessionId: string;
    orgId: string;
    plan: Exclude<PlanId, 'free'>;
    billingInterval: BillingInterval;
    quantity: number;
    createdBy: string | null;
  },
): Promise<void> {
  await exec.insert(billingCheckouts).values(checkout).onConflictDoNothing();
}

export async function findCheckout(
  exec: Executor,
  sessionId: string,
): Promise<CheckoutRecord | null> {
  const [row] = await exec
    .select()
    .from(billingCheckouts)
    .where(eq(billingCheckouts.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/* ── seat-sync debts ───────────────────────────────────────────────────────── */

export type SeatSyncRecord = typeof billingSeatSyncs.$inferSelect;

/**
 * Records that the organisation's seat count is owed to the provider, before
 * the push is attempted. A second queue for an organisation already owed is a
 * no-op that keeps the original `queued_at`.
 */
export async function queueSeatSync(exec: Executor, orgId: string): Promise<void> {
  await exec.insert(billingSeatSyncs).values({ orgId }).onConflictDoNothing();
}

/** The debts, oldest first. */
export async function listSeatSyncs(exec: Executor, limit: number): Promise<SeatSyncRecord[]> {
  return exec.select().from(billingSeatSyncs).orderBy(asc(billingSeatSyncs.queuedAt)).limit(limit);
}

/**
 * Pays a debt — only if it was queued no later than `pushedAt`.
 *
 * A membership change that queued a fresh debt while this push was in flight
 * re-queues nothing (the row already existed), so the push that started first
 * must not delete the row that the later change is relying on. Comparing
 * `queued_at` is not enough on its own for that — the later change did not
 * write — which is why the push re-counts after it lands (see `syncSeats`).
 * This guard is the second line: a debt is only ever cleared by a push that
 * began after it was queued.
 */
export async function completeSeatSync(
  exec: Executor,
  orgId: string,
  pushedAt: Date,
): Promise<void> {
  await exec
    .delete(billingSeatSyncs)
    .where(
      and(eq(billingSeatSyncs.orgId, orgId), sql`${billingSeatSyncs.queuedAt} <= ${pushedAt}`),
    );
}

/** Records a failed push. `category` is a short token, never a provider message. */
export async function failSeatSync(exec: Executor, orgId: string, category: string): Promise<void> {
  const now = new Date();
  await exec
    .insert(billingSeatSyncs)
    .values({ orgId, attempts: 1, lastAttemptAt: now, lastError: category.slice(0, 64) })
    .onConflictDoUpdate({
      target: billingSeatSyncs.orgId,
      set: {
        attempts: sql`${billingSeatSyncs.attempts} + 1`,
        lastAttemptAt: now,
        lastError: category.slice(0, 64),
      },
    });
}

/* ── usage ─────────────────────────────────────────────────────────────────── */

/**
 * The usage period a fetch counts towards, as SQL over `org_subscriptions`.
 *
 * The paid period while one is current — so the meter and the invoice agree
 * on what "this month" is — and the calendar month in UTC otherwise: Free has
 * no billing period, and a stale period (a renewal webhook that never came)
 * must not keep collecting fetches after its end.
 *
 * One expression, used by the writer and the reader alike, so the billing
 * screen can never be reading a different row from the one being added to.
 */
export const USAGE_PERIOD_START = sql<Date>`(case
  when ${orgSubscriptions.currentPeriodStart} is not null
   and ${orgSubscriptions.currentPeriodEnd} > now()
  then ${orgSubscriptions.currentPeriodStart}
  else (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')
end)`;

/**
 * Adds accumulated fetch counts, one statement for any number of
 * organisations.
 *
 * **The destination of a flush, never of a fetch.** The request path counts in
 * memory (`apps/web/src/server/billing/usage.ts`) and hands batches here from
 * `waitUntil`, after the response has gone. Additive inside the statement, so
 * two isolates flushing at once both land.
 */
export async function addFetchCounts(
  exec: Executor,
  counts: readonly { orgId: string; fetches: number }[],
): Promise<void> {
  const rows = counts.filter((entry) => Number.isSafeInteger(entry.fetches) && entry.fetches > 0);
  if (rows.length === 0) return;

  const values = sql.join(
    rows.map((entry) => sql`(${entry.orgId}::uuid, ${entry.fetches}::bigint)`),
    sql`, `,
  );

  await exec.execute(sql`
    insert into ${orgUsageCounters} (org_id, period_start, secret_fetches)
    select counted.org_id, ${USAGE_PERIOD_START}, counted.fetches
      from (values ${values}) as counted(org_id, fetches)
      join ${orgSubscriptions} on ${orgSubscriptions.orgId} = counted.org_id
    on conflict (org_id, period_start) do update
      set secret_fetches = ${orgUsageCounters.secretFetches} + excluded.secret_fetches,
          updated_at = now()
  `);
}

/** This period's counter for an organisation, as the billing screen shows it. */
export async function currentUsage(
  exec: Executor,
  orgId: string,
): Promise<{ periodStart: Date; secretFetches: number; meteredUnitsSent: number }> {
  const [period] = await exec
    .select({ start: USAGE_PERIOD_START })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1);
  const periodStart = period ? new Date(period.start) : monthStartUtc(new Date());

  const [row] = await exec
    .select({
      secretFetches: orgUsageCounters.secretFetches,
      meteredUnitsSent: orgUsageCounters.meteredUnitsSent,
    })
    .from(orgUsageCounters)
    .where(and(eq(orgUsageCounters.orgId, orgId), eq(orgUsageCounters.periodStart, periodStart)))
    .limit(1);

  return {
    periodStart,
    secretFetches: row?.secretFetches ?? 0,
    meteredUnitsSent: row?.meteredUnitsSent ?? 0,
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A usage row the metering flush may owe the provider for. */
export interface MeterableUsage {
  orgId: string;
  periodStart: Date;
  secretFetches: number;
  meteredUnitsSent: number;
  subscription: SubscriptionRecord;
}

/**
 * Usage rows written recently, on subscriptions the provider bills — the flush's
 * work list. What is *owed* is decided by the caller from the resolved plan
 * (overrides included); this only finds the candidates.
 *
 * Trials are left out: a trial is free, and an overage charge during one would
 * be the first payment the customer ever made to us, for something the trial
 * was supposed to let them try.
 */
export async function listMeterableUsage(
  exec: Executor,
  options: { since: Date; limit: number },
): Promise<MeterableUsage[]> {
  const rows = await exec
    .select({ usage: orgUsageCounters, subscription: orgSubscriptions })
    .from(orgUsageCounters)
    .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, orgUsageCounters.orgId))
    .where(
      and(
        gt(orgUsageCounters.updatedAt, options.since),
        ne(orgSubscriptions.plan, 'free'),
        ne(orgSubscriptions.status, 'trialing'),
        isNotNull(orgSubscriptions.dodoCustomerId),
        isNotNull(orgSubscriptions.dodoSubscriptionId),
        gt(orgUsageCounters.secretFetches, 0),
      ),
    )
    .orderBy(asc(orgUsageCounters.updatedAt))
    .limit(options.limit);

  return rows.map((row) => ({
    orgId: row.usage.orgId,
    periodStart: row.usage.periodStart,
    secretFetches: row.usage.secretFetches,
    meteredUnitsSent: row.usage.meteredUnitsSent,
    subscription: row.subscription,
  }));
}

/**
 * Records that the provider has accepted every unit up to `sentUpTo`.
 *
 * `GREATEST`, not an addition. Units are reported with deterministic ids, so
 * the provider is idempotent on its side; this makes the record idempotent on
 * ours. Two flushes that both reported units 0–9 both write 10, never 20 — an
 * addition here would mark units as billed that never were, and quietly stop
 * the next ten from being reported at all.
 */
export async function markMeteredUnitsSent(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  sentUpTo: number,
): Promise<void> {
  if (!Number.isSafeInteger(sentUpTo) || sentUpTo <= 0) return;
  await exec
    .insert(orgUsageCounters)
    .values({ orgId, periodStart, secretFetches: 0, meteredUnitsSent: sentUpTo })
    .onConflictDoUpdate({
      target: [orgUsageCounters.orgId, orgUsageCounters.periodStart],
      set: {
        meteredUnitsSent: sql`greatest(${orgUsageCounters.meteredUnitsSent}, ${sentUpTo})`,
        updatedAt: new Date(),
      },
    });
}

/* ── reminders ─────────────────────────────────────────────────────────────── */

/**
 * Claims a reminder, returning false when it was already sent.
 *
 * **This is the deduplication**, the same way `claimWebhookEvent` is: the insert
 * wins the primary key or it does not, so two hourly runs racing cannot both
 * send. Claimed before the mail goes, so a mail provider that is down costs a
 * reminder rather than duplicating one — a missed "your trial ends tomorrow"
 * is an inconvenience, five of them is the mail bomb the throttle exists to
 * prevent.
 */
export async function claimReminder(
  exec: Executor,
  reminder: { orgId: string; kind: BillingReminderKind; occasion: string },
): Promise<boolean> {
  const inserted = await exec
    .insert(billingReminders)
    .values({ ...reminder, occasion: reminder.occasion.slice(0, 128) })
    .onConflictDoNothing()
    .returning({ orgId: billingReminders.orgId });
  return inserted.length > 0;
}

/** Whether a reminder of this kind went out for this organisation since `since`. */
export async function reminderSentSince(
  exec: Executor,
  orgId: string,
  kind: BillingReminderKind,
  since: Date,
): Promise<boolean> {
  const [row] = await exec
    .select({ orgId: billingReminders.orgId })
    .from(billingReminders)
    .where(
      and(
        eq(billingReminders.orgId, orgId),
        eq(billingReminders.kind, kind),
        gt(billingReminders.sentAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Housekeeping: forgets reminders sent before `before`. */
export async function pruneReminders(exec: Executor, before: Date): Promise<void> {
  await exec.delete(billingReminders).where(lt(billingReminders.sentAt, before));
}

/* ── licence keys ──────────────────────────────────────────────────────────── */

/**
 * Records a licence key the provider issued — **never the key itself**.
 * Returns false for one already recorded.
 */
export async function recordLicenseKey(
  exec: Executor,
  licence: {
    licenseKeyId: string;
    productId: string;
    dodoCustomerId: string | null;
    dodoSubscriptionId: string | null;
    dodoPaymentId: string | null;
    activationsLimit: number | null;
    expiresAt: Date | null;
    issuedAt: Date | null;
  },
): Promise<boolean> {
  const inserted = await exec
    .insert(billingLicenseKeys)
    .values(licence)
    .onConflictDoNothing()
    .returning({ id: billingLicenseKeys.licenseKeyId });
  return inserted.length > 0;
}

/* ── the billing screen ────────────────────────────────────────────────────── */

/**
 * The countables the billing screen warns about, in one round trip.
 *
 * For the dashboard only — never the request path of anything else.
 */
export async function billingCounts(
  exec: Executor,
  orgId: string,
  now: Date,
): Promise<{
  seatedMembers: number;
  pendingInvitations: number;
  projects: number;
  serviceTokens: number;
}> {
  const [row] = await exec
    .select({
      seatedMembers: sql<number>`(select count(*)::int from ${orgMembers}
        where ${orgMembers.orgId} = ${orgId} and ${orgMembers.seatAssigned})`,
      pendingInvitations: sql<number>`(select count(*)::int from ${invitations}
        where ${invitations.orgId} = ${orgId}
          and ${invitations.acceptedAt} is null
          and ${invitations.revokedAt} is null
          and ${invitations.expiresAt} > ${now})`,
      projects: sql<number>`(select count(*)::int from ${projects}
        where ${projects.orgId} = ${orgId} and ${projects.deletedAt} is null)`,
      serviceTokens: sql<number>`(select count(*)::int from ${serviceTokens}
        where ${serviceTokens.orgId} = ${orgId} and ${serviceTokens.revokedAt} is null)`,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return {
    seatedMembers: Number(row?.seatedMembers ?? 0),
    pendingInvitations: Number(row?.pendingInvitations ?? 0),
    projects: Number(row?.projects ?? 0),
    serviceTokens: Number(row?.serviceTokens ?? 0),
  };
}
