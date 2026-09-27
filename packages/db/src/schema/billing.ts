import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PlanId, StoredPlanId } from '@xecret/core/entitlements';
import { billingIntervalEnum, planIdEnum, subscriptionStatusEnum } from './enums';
import { organizations } from './tenancy';

/**
 * What each organisation has paid for, and how much of it they have used.
 *
 * ── Why this is our table and not a lookup against the payment provider ──
 * D15: Dodo is the *billing* truth, this table is the *access* truth. The data
 * path may never depend on a third party being reachable — the same reasoning
 * that keeps the Root KEK out of a runtime fetch (ADR 0002). An organisation's
 * entitlements resolve from a row we already loaded for authorization, so a
 * Dodo outage is invisible to every secret fetch in the system.
 *
 * Webhooks reconcile this table towards Dodo. Nothing reads Dodo synchronously.
 *
 * ── Why it exists before any payment code does ──
 * Billing is built second-to-last (plan order 11), but every phase before it
 * needs something to gate on. These rows are written by the manual operator
 * tool (`npm run plan:set`) until the webhooks arrive, and by both afterwards —
 * support still needs a way to grant a trial extension or an Enterprise deal
 * that never passed through checkout.
 */

/**
 * One row per organisation, created with the organisation.
 *
 * Not nullable-by-absence: an organisation without a subscription row would
 * make every entitlement lookup a left join with a fallback, and the fallback
 * would eventually diverge from the Free plan it is meant to mirror. The
 * migration backfills every existing organisation and `provisionOrganization`
 * inserts one in the same transaction.
 */
export const orgSubscriptions = pgTable(
  'org_subscriptions',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    plan: planIdEnum('plan').notNull().default('free'),
    status: subscriptionStatusEnum('status').notNull().default('active'),

    /** Null on Free, which is never billed and therefore has no interval. */
    billingInterval: billingIntervalEnum('billing_interval'),

    /**
     * Seats billed — which is not the same as seats used.
     *
     * `organizations.seat_limit` is what the member service enforces; this is
     * what the invoice says. They are synced, and they are separate because
     * the failure modes differ: a drift in `seat_limit` blocks an invitation,
     * a drift here charges the wrong amount. Keeping one column for both would
     * make every reconciliation bug a billing bug.
     */
    seats: integer('seats').notNull().default(1),

    /**
     * ISO-4217, chosen server-side at checkout and never from a client.
     *
     * Together with `billing_country` this is the purchasing-power guardrail
     * (pricing-plan §4). A customer cannot select a currency; we derive it from
     * where Dodo says they are, and Dodo tells us the card-issuer country too.
     */
    currency: text('currency'),

    /** ISO-3166-1 alpha-2, as reported by the payment provider. */
    billingCountry: text('billing_country'),

    /**
     * PPP region lock — 12 months from first purchase.
     *
     * Stops a customer repricing themselves by travelling. A region change
     * re-prices at renewal, never mid-term, so this is a date rather than a
     * boolean: the rule needs to say *when* it stops applying.
     */
    regionLockedUntil: timestamp('region_locked_until', { withTimezone: true }),

    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),

    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),

    /**
     * The 24-month grandfather promise, as a column rather than a note.
     *
     * pricing-plan §10 commits to grandfathering every early customer for two
     * years. A promise that lives only in marketing copy is a promise broken by
     * the first migration that reprices a plan — so it lives here, where a
     * repricing job has to read it.
     */
    grandfatheredUntil: timestamp('grandfathered_until', { withTimezone: true }),

    dodoCustomerId: text('dodo_customer_id'),
    dodoSubscriptionId: text('dodo_subscription_id').unique(),

    /**
     * Separately purchased, never bundled into a plan.
     *
     * Each of these costs a real $125/month WorkOS connection. They are
     * booleans on the organisation rather than flags on the plan precisely so
     * that no tier can ever quietly include one — see `OrgAddons` in
     * `@xecret/core/entitlements`.
     */
    addonSaml: boolean('addon_saml').notNull().default(false),
    addonDirectorySync: boolean('addon_directory_sync').notNull().default(false),

    /**
     * Support-granted ceiling raises, keyed by `PlanLimits` field name.
     *
     * The mechanism behind the fair-usage promise that a ceiling hit in good
     * faith gets raised for free, without a deploy. Applied raise-only by
     * `resolveEntitlements`, so a malformed row can never downgrade anyone.
     */
    limitOverrides: jsonb('limit_overrides').$type<Record<string, number | null>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('org_subscriptions_seats_check', sql`${t.seats} >= 0`),
    // Free is never billed, so it must never carry an interval; every paid plan
    // must. Enforced here rather than in application code because the invariant
    // is about what the row *means*, and a row that means nothing coherent is
    // how a subscription ends up charged twice or not at all.
    check(
      'org_subscriptions_interval_check',
      sql`(${t.plan} = 'free') = (${t.billingInterval} is null)`,
    ),
    check(
      'org_subscriptions_currency_check',
      sql`${t.currency} is null or ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'org_subscriptions_country_check',
      sql`${t.billingCountry} is null or ${t.billingCountry} ~ '^[A-Z]{2}$'`,
    ),
    // The reconciler sweeps every subscription whose period has ended, and the
    // dunning job sweeps by status. Both read this index rather than the table.
    index('org_subscriptions_status_period_idx').on(t.status, t.currentPeriodEnd),
  ],
);

/**
 * Secret fetches, per organisation, per billing period.
 *
 * ── Why a counter table and not a count over the audit log ──
 * Audit rows are partitioned, retained by plan, and pruned. Billing arithmetic
 * over a table that forgets is arithmetic that changes its mind. This table
 * holds the number we would show a customer disputing an invoice, and it holds
 * it for as long as the dispute window lasts rather than as long as their audit
 * retention does.
 *
 * ── The one thing this table must never become ──
 * A write on the hot path. A fetch that costs an extra UPDATE is a fetch that
 * doubles its p99 to record a number nobody reads in real time. Counts
 * accumulate in the Worker and flush periodically (P12); this table is the
 * destination of the flush, not the fetch.
 */
export const orgUsageCounters = pgTable(
  'org_usage_counters',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Start of the billing period these counts belong to. Half of the key. */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),

    secretFetches: bigint('secret_fetches', { mode: 'number' }).notNull().default(0),

    /**
     * Metered units already reported to the payment provider.
     *
     * Subtracted from what is owed so that a retried flush cannot bill twice.
     * Ours is the authoritative count; this column is what makes the reporting
     * of it idempotent.
     */
    meteredUnitsSent: bigint('metered_units_sent', { mode: 'number' }).notNull().default(0),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A composite **primary key**, not an index — and the distinction is the
    // whole behaviour of this table. `recordFetches` and `recordMeteredUnits`
    // are `INSERT … ON CONFLICT (org_id, period_start) DO UPDATE`, and Postgres
    // resolves that conflict target against a unique constraint. Against a plain
    // index it does not resolve at all: the statement fails with "there is no
    // unique or exclusion constraint matching the ON CONFLICT specification",
    // and two concurrent flushes could otherwise insert two rows for one period
    // and halve the number an invoice is argued from.
    //
    // Named to match migration 0016, which has always created it correctly. The
    // model said `index(...)`, so `db:generate` would have emitted a drift
    // migration dropping the real key — and any environment built from the model
    // rather than the SQL got a table the upserts cannot run against.
    primaryKey({ name: 'org_usage_counters_pkey', columns: [t.orgId, t.periodStart] }),
    check('org_usage_counters_fetches_check', sql`${t.secretFetches} >= 0`),
    check('org_usage_counters_units_check', sql`${t.meteredUnitsSent} >= 0`),
  ],
);

/**
 * Delivered webhook ids, for idempotency.
 *
 * Dodo retries a failed delivery eight times and will deliver duplicates. The
 * primary key on `webhook_id` **is** the deduplication: the handler inserts
 * first and processes only if the insert won, inside one transaction. A
 * SELECT-then-INSERT would leave a window two concurrent retries can both pass
 * through, and the consequence of passing through twice is a double grant or a
 * double charge.
 *
 * Created here rather than in P12 so that the constraint exists before the code
 * that depends on it — a migration is a worse thing to forget under deadline
 * than a handler is.
 */
export const billingWebhookEvents = pgTable(
  'billing_webhook_events',
  {
    webhookId: text('webhook_id').primaryKey(),
    eventType: text('event_type').notNull(),
    /** Provider's own timestamp, kept for out-of-order detection. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  },
  (t) => [
    // The retention sweep deletes by age; nothing else scans this table.
    index('billing_webhook_events_received_idx').on(t.receivedAt),
    index('billing_webhook_events_org_idx').on(t.orgId),
  ],
);

/**
 * Re-exported so callers get the plan unions without importing core directly.
 *
 * Both, deliberately. `orgSubscriptions.plan` yields `StoredPlanId`, which is
 * wider than `PlanId` by exactly the tiers this product has withdrawn — so a
 * caller who followed the old comment and reached for `PlanId` got a type that
 * excludes the one value the column can actually hold. Read as `StoredPlanId`,
 * decide as `PlanId`, and cross between them with `resolvePlanId`.
 */
export type { PlanId, StoredPlanId };
