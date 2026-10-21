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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PlanId, StoredPlanId } from '@xecret/core/entitlements';
import { billingIntervalEnum, planIdEnum, subscriptionStatusEnum } from './enums';
import { users } from './identity';
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
    /**
     * Start of the paid period — the provider's `previous_billing_date`
     * (migration 0024). The usage counter is keyed by it, so the meter's
     * period and the invoice's period are the same period.
     */
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
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
     * The product the subscription is on (migration 0024). A seat change names
     * the product the customer holds, never one re-derived from a catalog that
     * may have moved since they bought it.
     */
    dodoProductId: text('dodo_product_id'),
    /**
     * The provider timestamp of the last subscription snapshot applied. Older
     * snapshots are stale and skipped: webhooks arrive out of order.
     */
    dodoEventAt: timestamp('dodo_event_at', { withTimezone: true }),
    /**
     * What the next renewal charges before tax, in the currency's smallest
     * unit. Quoted by the renewal notice; never read for access.
     */
    renewalAmountMinor: bigint('renewal_amount_minor', { mode: 'number' }),

    /**
     * The first moment this subscription's usage may be billed (migration
     * 0025): its activation, or its trial's end when it had one. The overage
     * report meters only counter rows whose period starts at or after it, so
     * fetches made on Free or during a trial are never billed by the
     * subscription that followed them. `null` meters nothing.
     */
    meteredFrom: timestamp('metered_from', { withTimezone: true }),
    /**
     * Which Dodo the row's provider ids belong to (migration 0025). An event
     * from the other mode is never applied to it, and no job calls Dodo for
     * it from a deployment of the other mode. `null`: no mode recorded yet.
     */
    dodoMode: text('dodo_mode').$type<'test_mode' | 'live_mode'>(),
    /**
     * The webhook id of the last snapshot applied (migration 0025) — the
     * tie-break when two snapshots carry the same provider timestamp.
     */
    dodoEventId: text('dodo_event_id'),
    /** When the subscription last went on hold (migration 0025); `null` when it is not. */
    onHoldSince: timestamp('on_hold_since', { withTimezone: true }),
    /**
     * When a plan change Dodo has scheduled takes effect (migration 0025) — a
     * downgrade waiting for the period end. A seat push waits for it too.
     */
    dodoScheduledChangeAt: timestamp('dodo_scheduled_change_at', { withTimezone: true }),
    /**
     * The currency and billing country Dodo last reported (migration 0025),
     * whatever the region lock kept in `currency` and `billing_country`.
     * `renewal_amount_minor` is in this currency.
     */
    dodoCurrency: text('dodo_currency'),
    dodoBillingCountry: text('dodo_billing_country'),

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
    check(
      'org_subscriptions_renewal_amount_check',
      sql`${t.renewalAmountMinor} is null or ${t.renewalAmountMinor} >= 0`,
    ),
    check(
      'org_subscriptions_dodo_mode_check',
      sql`${t.dodoMode} is null or ${t.dodoMode} in ('test_mode', 'live_mode')`,
    ),
    check(
      'org_subscriptions_dodo_event_id_check',
      sql`${t.dodoEventId} is null or length(${t.dodoEventId}) between 1 and 255`,
    ),
    check(
      'org_subscriptions_dodo_currency_check',
      sql`${t.dodoCurrency} is null or ${t.dodoCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'org_subscriptions_dodo_country_check',
      sql`${t.dodoBillingCountry} is null or ${t.dodoBillingCountry} ~ '^[A-Z]{2}$'`,
    ),
    // The reconciler sweeps every subscription whose period has ended, and the
    // dunning job sweeps by status. Both read this index rather than the table.
    index('org_subscriptions_status_period_idx').on(t.status, t.currentPeriodEnd),
    index('org_subscriptions_dodo_customer_idx')
      .on(t.dodoCustomerId)
      .where(sql`${t.dodoCustomerId} is not null`),
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

    /**
     * Start of the month these counts belong to. Half of the key. A monthly
     * plan's billing period, Free's calendar month, or a month of a yearly
     * plan's year counted from its billing anniversary — the allowance is
     * monthly, so what it is measured against is too.
     */
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

    /**
     * The fetches the plan included for this month, as it stood when the
     * month opened (migration 0026) — the plan's allowance with any support
     * raise of it. Raised, never lowered, by a flush while the month is still
     * current. The overage meter bills the month against this and nothing
     * else, so a later downgrade or a cleared override never re-bills it.
     * `null`: not recorded, and never metered.
     */
    includedFetches: bigint('included_fetches', { mode: 'number' }),

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
    check(
      'org_usage_counters_included_check',
      sql`${t.includedFetches} is null or ${t.includedFetches} >= 0`,
    ),
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
 * Every hosted checkout an owner was sent to (migration 0024).
 *
 * The way back from a payment to the organisation that started it: payment
 * events carry the checkout session id, and this row — written by our own
 * server call that minted the session — says whose it was. Insert-only by
 * grant, but for the two columns a consumption sets (migration 0025).
 *
 * `nonce` is the binding (migration 0025): random, minted per checkout, sent to
 * Dodo as metadata. A subscription is attached to an organisation by metadata
 * only when it carries the nonce of an open checkout of that organisation, so a
 * purchase made anywhere but our own checkout attaches to nothing.
 */
export const billingCheckouts = pgTable(
  'billing_checkouts',
  {
    sessionId: text('session_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    plan: planIdEnum('plan').notNull().$type<PlanId>(),
    billingInterval: billingIntervalEnum('billing_interval').notNull(),
    quantity: integer('quantity').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    nonce: text('nonce'),
    /** The subscription this checkout produced, once one did (migration 0025). */
    subscriptionId: text('subscription_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('billing_checkouts_quantity_check', sql`${t.quantity} >= 1`),
    check('billing_checkouts_plan_check', sql`${t.plan} <> 'free'`),
    check('billing_checkouts_session_id_check', sql`length(${t.sessionId}) between 1 and 255`),
    check(
      'billing_checkouts_nonce_check',
      sql`${t.nonce} is null or length(${t.nonce}) between 16 and 128`,
    ),
    check(
      'billing_checkouts_subscription_id_check',
      sql`${t.subscriptionId} is null or length(${t.subscriptionId}) between 1 and 255`,
    ),
    index('billing_checkouts_org_idx').on(t.orgId, t.createdAt),
    uniqueIndex('billing_checkouts_nonce_unique')
      .on(t.nonce)
      .where(sql`${t.nonce} is not null`),
  ],
);

/**
 * Seat changes still owed to the payment provider (migration 0024).
 *
 * Written inside the membership change's own transaction, so a push that
 * fails, dies with the isolate, or never starts leaves a debt the hourly job
 * collects. Holds no count on purpose: a push sends the count as it is *then*.
 *
 * Migration 0025 adds the serialisation: `generation` is bumped by every
 * membership change and a push clears the debt only under the generation it
 * counted, `claimed_until` is the one push in flight, `not_before` is when the
 * debt is next due, and `dead_lettered_at` is a debt given up on and raised.
 */
export const billingSeatSyncs = pgTable(
  'billing_seat_syncs',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** A category, e.g. `upstream_5xx`, never a provider message. */
    lastError: text('last_error'),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    notBefore: timestamp('not_before', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
  },
  (t) => [
    check('billing_seat_syncs_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'billing_seat_syncs_last_error_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= 64`,
    ),
    check('billing_seat_syncs_generation_check', sql`${t.generation} >= 1`),
  ],
);

/**
 * The billing emails, by kind. The database refuses any other (migration
 * 0024; `plan_ended_unpaid` from 0025).
 */
export const BILLING_REMINDER_KINDS = [
  'trial_ending_3d',
  'trial_ending_1d',
  'payment_failed',
  'card_expiring',
  'renewal_upcoming',
  'seats_changed',
  'usage_80',
  'usage_100',
  'invoice_available',
  'plan_ended_unpaid',
] as const;

export type BillingReminderKind = (typeof BILLING_REMINDER_KINDS)[number];

/**
 * The alerts for a human that the billing jobs raise once rather than on every
 * run while their cause lasts (migration 0027). Kept in the reminders' ledger,
 * deduplicated by the same key; never an email.
 *
 *  - `alert_unknown_product`: a subscription a job asked Dodo about is on a
 *    product this deployment does not sell. Once per subscription and product.
 *  - `alert_activation_waiting`: a paid checkout's subscription, a day after
 *    its payment linked it, is still pending at Dodo or unknown to it.
 *  - `alert_operator_managed`: a paid row follows a subscription id with no
 *    product recorded — an operator's grant over an old subscription's id.
 */
export const BILLING_ALERT_KINDS = [
  'alert_unknown_product',
  'alert_activation_waiting',
  'alert_operator_managed',
] as const;

export type BillingAlertKind = (typeof BILLING_ALERT_KINDS)[number];

/**
 * Which billing emails have gone out (migration 0024), and which once-only
 * alerts have been raised (0027). The primary key is the deduplication: a
 * reminder is sent, or an alert raised, only by whoever won the insert.
 */
export const billingReminders = pgTable(
  'billing_reminders',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<BillingReminderKind | BillingAlertKind>(),
    /** What is being reminded about: a trial end date, a period, a payment. */
    occasion: text('occasion').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'billing_reminders_pkey', columns: [t.orgId, t.kind, t.occasion] }),
    check(
      'billing_reminders_kind_check',
      sql.raw(
        `"kind" IN (${[...BILLING_REMINDER_KINDS, ...BILLING_ALERT_KINDS].map((kind) => `'${kind}'`).join(', ')})`,
      ),
    ),
    check('billing_reminders_occasion_check', sql`length(${t.occasion}) between 1 and 128`),
    index('billing_reminders_sent_idx').on(t.sentAt),
  ],
);

/** What an idempotency key in `billing_requests` was used for. */
export const BILLING_REQUEST_KINDS = ['checkout', 'change'] as const;
export type BillingRequestKind = (typeof BILLING_REQUEST_KINDS)[number];

/**
 * An owner's checkout or plan change, by the idempotency key the billing
 * screen sent (migration 0025). The primary key is the deduplication: a second
 * request with the key gets the first one's `result` instead of a second
 * checkout or a second change at Dodo. `fingerprint` is what was asked for, so
 * a key reused for a different request is refused. Pruned after a day.
 */
export const billingRequests = pgTable(
  'billing_requests',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<BillingRequestKind>(),
    idempotencyKey: text('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'billing_requests_pkey', columns: [t.orgId, t.kind, t.idempotencyKey] }),
    check('billing_requests_kind_check', sql`${t.kind} in ('checkout', 'change')`),
    check('billing_requests_key_check', sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_-]{16,128}$'`),
    check('billing_requests_fingerprint_check', sql`length(${t.fingerprint}) between 1 and 64`),
    index('billing_requests_created_idx').on(t.createdAt),
  ],
);

/**
 * Self-host licence keys the provider issued, stored against the order
 * (migration 0024). **The key itself is never stored** — the provider emails
 * it to the buyer; this is the record that it exists.
 */
export const billingLicenseKeys = pgTable(
  'billing_license_keys',
  {
    licenseKeyId: text('license_key_id').primaryKey(),
    productId: text('product_id').notNull(),
    dodoCustomerId: text('dodo_customer_id'),
    dodoSubscriptionId: text('dodo_subscription_id'),
    dodoPaymentId: text('dodo_payment_id'),
    activationsLimit: integer('activations_limit'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'billing_license_keys_activations_check',
      sql`${t.activationsLimit} is null or ${t.activationsLimit} >= 0`,
    ),
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
