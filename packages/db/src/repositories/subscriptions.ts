import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_PLAN,
  resolveEntitlements,
  type Entitlements,
  type StoredPlanId,
  type SubscriptionStatus,
} from '@xecret/core/entitlements';
import { billingWebhookEvents, orgSubscriptions, orgUsageCounters } from '../schema/billing';
import { organizations } from '../schema/tenancy';
import type { Executor, Transaction } from './shared';

/**
 * Subscriptions, entitlements and usage counters.
 *
 * ── The one performance rule ──
 * `loadEntitlements` exists for scripts and for the dashboard. The request path
 * does **not** call it: entitlements there are resolved from the row the
 * authorization context already loaded (`entitlementsFromRow`), because adding
 * a query to the hot path to answer a billing question would be paying latency
 * on every secret fetch for something that changes once a month.
 *
 * ── The one correctness rule ──
 * Nothing here reads the payment provider. D15: Dodo is the billing truth,
 * these rows are the access truth, and the two are reconciled by webhooks
 * asynchronously. A secret fetch that waited on a third party would inherit
 * that party's uptime, which is the failure ADR 0002 already refused once.
 */

export type SubscriptionRecord = typeof orgSubscriptions.$inferSelect;

/** The columns entitlement resolution needs, and nothing else. */
export interface SubscriptionEntitlementRow {
  /** As stored. A retired plan is resolved by `resolveEntitlements`, not here. */
  plan: StoredPlanId;
  status: SubscriptionStatus;
  addonSaml: boolean;
  addonDirectorySync: boolean;
  limitOverrides: Record<string, number | null> | null;
  currentPeriodEnd: Date | null;
}

/**
 * Turn a loaded row into entitlements. Pure — no query, no clock, no IO.
 *
 * This is what the request path calls, with a row the authorization context
 * already fetched. Keeping it separate from `loadEntitlements` is what makes
 * "no extra query on the hot path" a structural property rather than a
 * convention somebody has to remember.
 */
export function entitlementsFromRow(
  row: SubscriptionEntitlementRow | null | undefined,
): Entitlements {
  if (!row) {
    // An organisation with no subscription row should not exist — the migration
    // backfilled every one and provisioning inserts alongside. Resolving to
    // Free is the same answer the migration would have written, and it is the
    // safe direction to be wrong in.
    return resolveEntitlements({
      plan: DEFAULT_PLAN,
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
    });
  }

  return resolveEntitlements({
    plan: row.plan,
    status: row.status,
    addonSaml: row.addonSaml,
    addonDirectorySync: row.addonDirectorySync,
    limitOverrides: row.limitOverrides ?? undefined,
    currentPeriodEnd: row.currentPeriodEnd,
  });
}

/** The projection `entitlementsFromRow` consumes, for joining into other queries. */
export const entitlementColumns = {
  plan: orgSubscriptions.plan,
  status: orgSubscriptions.status,
  addonSaml: orgSubscriptions.addonSaml,
  addonDirectorySync: orgSubscriptions.addonDirectorySync,
  limitOverrides: orgSubscriptions.limitOverrides,
  currentPeriodEnd: orgSubscriptions.currentPeriodEnd,
} as const;

/** The subscription-lookup query, exposed so `.toSQL()` tests can assert its shape. */
export function subscriptionQuery(exec: Executor, orgId: string) {
  return exec.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
}

export async function findSubscription(
  exec: Executor,
  orgId: string,
): Promise<SubscriptionRecord | null> {
  const [row] = await subscriptionQuery(exec, orgId);
  return row ?? null;
}

/**
 * Load and resolve in one call. **Not for the request path** — see the header.
 *
 * Used by the operator tool, the dashboard's billing page, and the reconciler,
 * all of which are already doing IO and none of which are latency-sensitive.
 */
export async function loadEntitlements(exec: Executor, orgId: string): Promise<Entitlements> {
  return entitlementsFromRow(await findSubscription(exec, orgId));
}

/**
 * Create the Free subscription that every organisation starts with.
 *
 * Called inside the provisioning transaction, so an organisation and its
 * subscription commit together or not at all. `DO NOTHING` rather than an
 * error on conflict: provisioning is retried in places, and a second attempt
 * finding the row already there is success, not a conflict to report.
 */
export async function createFreeSubscription(exec: Executor, orgId: string): Promise<void> {
  await exec.insert(orgSubscriptions).values({ orgId }).onConflictDoNothing();
}

export interface SubscriptionPatch {
  plan?: StoredPlanId;
  status?: SubscriptionStatus;
  billingInterval?: 'monthly' | 'yearly' | null;
  seats?: number;
  currency?: string | null;
  billingCountry?: string | null;
  regionLockedUntil?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  grandfatheredUntil?: Date | null;
  dodoCustomerId?: string | null;
  dodoSubscriptionId?: string | null;
  addonSaml?: boolean;
  addonDirectorySync?: boolean;
  limitOverrides?: Record<string, number | null> | null;
}

/**
 * Apply a patch to one organisation's subscription.
 *
 * Returns the updated row so the caller can audit the before/after without a
 * second read. The caller supplies the audit event; this function does not,
 * because it is used by both an operator script and (later) a webhook handler,
 * and the actor differs.
 */
export async function updateSubscription(
  exec: Executor,
  orgId: string,
  patch: SubscriptionPatch,
): Promise<SubscriptionRecord | null> {
  const [row] = await exec
    .update(orgSubscriptions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(orgSubscriptions.orgId, orgId))
    .returning();
  return row ?? null;
}

/**
 * Seats billed, and the ceiling invitations are refused against.
 *
 * Two columns rather than one, deliberately: `seat_limit` is what the member
 * service enforces on an invitation, `org_subscriptions.seats` is what the
 * invoice says. Their failure modes differ — a drift in the first blocks an
 * invite, a drift in the second charges the wrong amount — and one column for
 * both would turn every reconciliation bug into a billing bug.
 *
 * **Two numbers, not one.** They are equal on every paid plan and they are not
 * equal on Free, which bills one seat while enforcing the column's default of
 * five. Taking a single `seats` here meant a Free organisation's invoice figure
 * was written into its access ceiling, and a three-person team could suddenly
 * invite nobody. `resolveBilledSeats` in `@xecret/core` decides the pair; this
 * only writes it.
 *
 * ── Why the parameter is a `Transaction` and not an `Executor` ──
 * Because this is two statements and the point of it is that they cannot
 * diverge. Every other repository function here takes an `Executor` so it works
 * standalone or inside a transaction — but "standalone" for this one means a
 * window where the invoice has moved and the ceiling has not, which is precisely
 * the state it exists to prevent. The type makes the caller open one rather than
 * leaving a comment asking them to.
 */
export async function setBilledSeats(
  tx: Transaction,
  orgId: string,
  seats: { billed: number; enforced: number },
): Promise<void> {
  const now = new Date();

  await tx
    .update(orgSubscriptions)
    .set({ seats: seats.billed, updatedAt: now })
    .where(eq(orgSubscriptions.orgId, orgId));

  await tx
    .update(organizations)
    .set({ seatLimit: seats.enforced, updatedAt: now })
    .where(eq(organizations.id, orgId));
}

/* ── usage counters ────────────────────────────────────────────────────────── */

export type UsageCounterRecord = typeof orgUsageCounters.$inferSelect;

/**
 * Add to the fetch counter for a period.
 *
 * **Never call this from the fetch path.** It is the destination of a periodic
 * flush that accumulates counts in the Worker; a fetch that paid for an UPDATE
 * would double its p99 to record a number nobody reads in real time.
 *
 * The upsert is `ON CONFLICT DO UPDATE` with an addition rather than a read,
 * add, write — two concurrent flushes must sum, not overwrite each other, and
 * the only place that can be guaranteed is inside the statement.
 */
export async function recordFetches(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  fetches: number,
): Promise<void> {
  if (fetches <= 0) return;
  await recordFetchesStatement(exec, orgId, periodStart, fetches);
}

/**
 * @internal Exported so `subscriptions.test.ts` can assert the upsert shape —
 * that it adds rather than overwrites, and that its conflict target is the
 * composite key — without a database.
 */
export function recordFetchesStatement(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  fetches: number,
) {
  return exec
    .insert(orgUsageCounters)
    .values({ orgId, periodStart, secretFetches: fetches })
    .onConflictDoUpdate({
      target: [orgUsageCounters.orgId, orgUsageCounters.periodStart],
      set: {
        secretFetches: sql`${orgUsageCounters.secretFetches} + ${fetches}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record metered units as reported to the payment provider.
 *
 * Additive for the same reason as `recordFetches`, and the column it feeds is
 * what stops a retried report from billing twice: units owed are always
 * computed as `floor(billable / unit) - unitsAlreadySent`.
 *
 * ── Why this is an upsert and not an UPDATE ──
 * It was an `UPDATE … WHERE org_id AND period_start`, which has no way to say
 * that it matched nothing: zero rows affected is a successful statement. The
 * caller would then believe the units were banked when they were not, and the
 * next flush — recomputing `floor(billable / unit) - unitsAlreadySent` with
 * `unitsAlreadySent` still zero — would report the same units to the provider a
 * second time. A double charge, produced by the one column that exists to
 * prevent double charges.
 *
 * The missing row is reachable: `recordFetches` returns early on a period with
 * no fetches, so a period can legitimately have units reported against no
 * counter row at all. Inserting `secret_fetches = 0` alongside is honest — no
 * fetch was counted — and it is the row the *next* `recordFetches` will add to.
 */
export async function recordMeteredUnits(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  units: number,
): Promise<void> {
  if (units <= 0) return;
  await recordMeteredUnitsStatement(exec, orgId, periodStart, units);
}

/**
 * @internal Exported so `subscriptions.test.ts` can assert that this is an
 * upsert and not the `UPDATE` it used to be — the difference between banking
 * the units and silently affecting no rows.
 */
export function recordMeteredUnitsStatement(
  exec: Executor,
  orgId: string,
  periodStart: Date,
  units: number,
) {
  return exec
    .insert(orgUsageCounters)
    .values({ orgId, periodStart, secretFetches: 0, meteredUnitsSent: units })
    .onConflictDoUpdate({
      target: [orgUsageCounters.orgId, orgUsageCounters.periodStart],
      set: {
        meteredUnitsSent: sql`${orgUsageCounters.meteredUnitsSent} + ${units}`,
        updatedAt: new Date(),
      },
    });
}

export function usageQuery(exec: Executor, orgId: string, periodStart: Date) {
  return exec
    .select()
    .from(orgUsageCounters)
    .where(and(eq(orgUsageCounters.orgId, orgId), eq(orgUsageCounters.periodStart, periodStart)))
    .limit(1);
}

export async function findUsage(
  exec: Executor,
  orgId: string,
  periodStart: Date,
): Promise<UsageCounterRecord | null> {
  const [row] = await usageQuery(exec, orgId, periodStart);
  return row ?? null;
}

/* ── webhook idempotency ───────────────────────────────────────────────────── */

/**
 * Claim a webhook delivery, returning false if it was already handled.
 *
 * **This is the deduplication, not a check before it.** The insert either wins
 * the primary key or it does not; two concurrent retries cannot both win. A
 * `SELECT` followed by an `INSERT` leaves a window both can pass through, and
 * on the other side of that window is a double grant or a double charge.
 *
 * Call inside the same transaction that processes the event, so that a handler
 * which throws rolls back the claim and lets the provider's retry succeed.
 */
export async function claimWebhookEvent(
  exec: Executor,
  params: {
    webhookId: string;
    eventType: string;
    occurredAt?: Date | null;
    orgId?: string | null;
  },
): Promise<boolean> {
  const inserted = await exec
    .insert(billingWebhookEvents)
    .values({
      webhookId: params.webhookId,
      eventType: params.eventType,
      occurredAt: params.occurredAt ?? null,
      orgId: params.orgId ?? null,
    })
    .onConflictDoNothing()
    .returning({ webhookId: billingWebhookEvents.webhookId });

  return inserted.length > 0;
}
