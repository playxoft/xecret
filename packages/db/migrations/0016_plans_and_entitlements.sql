-- Plans, entitlements, usage counters, and webhook idempotency.
--
-- The third authorization gate gets its storage. Capability (roles) and access
-- level (grants) already have theirs; this migration adds "and has this
-- organisation paid for it", which every phase after this one gates on.
--
-- ── Read this before running it ──
-- Additive only. Nothing is dropped, nothing changes shape, and every existing
-- row keeps working exactly as it does today. The one column that could not be
-- added as a nullable afterthought — `org_subscriptions.plan` — is created with
-- a DEFAULT of 'free', which is both the correct value for every existing
-- organisation and the correct value for every organisation created before
-- someone pays. There is no backfill to get wrong.
--
-- Rolling back is a restore rather than a down-migration, as with every other
-- migration here: the three new tables have no inverse. But nothing served by
-- the previous release stops working if this is applied and not deployed.
--
-- ── Why billing tables exist before any billing code ──
-- Payments are built second-to-last (.local/plans/v2/00-overview.md §2.1), but
-- every phase between here and there needs something to gate on. Until the
-- webhooks exist these rows are written by an operator running
-- `npm run plan:set`, and afterwards by both — support still needs a way to
-- grant a trial extension or an Enterprise deal that never passed through a
-- checkout page.
--
-- ── Order ──
-- Enums first, because three tables reference them. Then the tables, then the
-- backfill that gives every existing organisation its Free row, then grants.

-- ── enums ───────────────────────────────────────────────────────────────────
-- Declaration order is meaningful: Postgres orders enum values as declared, so
-- `ORDER BY plan` sorts weakest-to-strongest without a CASE expression, and it
-- matches PLAN_RANK in @xecret/core/entitlements.

CREATE TYPE "public"."plan_id" AS ENUM('free', 'pro', 'team', 'scale', 'enterprise');--> statement-breakpoint

CREATE TYPE "public"."billing_interval" AS ENUM('monthly', 'yearly');--> statement-breakpoint

-- `past_due` and `on_hold` are distinct on purpose: the first is a payment that
-- has not settled yet, the second is one that has failed. Neither removes any
-- access whatsoever — see isDataPlaneActive in @xecret/core/entitlements. The
-- only status that changes what an organisation may do is `expired`, and even
-- then it loses control-plane writes, never its secrets.
CREATE TYPE "public"."subscription_status" AS ENUM(
	'active', 'trialing', 'past_due', 'on_hold', 'cancelled', 'expired'
);--> statement-breakpoint

-- ── org_subscriptions ───────────────────────────────────────────────────────
-- One row per organisation, and the access truth for entitlements.
--
-- The payment provider is the *billing* truth; this table is what the data path
-- reads. Same reasoning as ADR 0002 for the Root KEK: a secret fetch must never
-- depend on a third party being reachable, so nothing here is ever looked up
-- synchronously from Dodo. Webhooks reconcile towards it.
--
-- Primary key is `org_id` rather than a surrogate: there is exactly one
-- subscription per organisation, and a surrogate key would admit two.

CREATE TABLE "org_subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan" "plan_id" DEFAULT 'free' NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"billing_interval" "billing_interval",
	"seats" integer DEFAULT 1 NOT NULL,
	"currency" text,
	"billing_country" text,
	"region_locked_until" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grandfathered_until" timestamp with time zone,
	"dodo_customer_id" text,
	"dodo_subscription_id" text,
	"addon_saml" boolean DEFAULT false NOT NULL,
	"addon_directory_sync" boolean DEFAULT false NOT NULL,
	"limit_overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_subscriptions_dodo_subscription_id_unique" UNIQUE("dodo_subscription_id"),
	CONSTRAINT "org_subscriptions_seats_check" CHECK ("org_subscriptions"."seats" >= 0),
	-- Free is never billed and therefore must carry no interval; every paid plan
	-- must carry one. Written as an equality between two booleans so that both
	-- halves of the invariant are one constraint: a paid plan with a null
	-- interval and a free plan with an interval are the same bug, and a system
	-- that admits either is a system that charges the wrong amount.
	CONSTRAINT "org_subscriptions_interval_check" CHECK (
		("org_subscriptions"."plan" = 'free') = ("org_subscriptions"."billing_interval" IS NULL)
	),
	CONSTRAINT "org_subscriptions_currency_check" CHECK (
		"org_subscriptions"."currency" IS NULL
		OR "org_subscriptions"."currency" ~ '^[A-Z]{3}$'
	),
	CONSTRAINT "org_subscriptions_country_check" CHECK (
		"org_subscriptions"."billing_country" IS NULL
		OR "org_subscriptions"."billing_country" ~ '^[A-Z]{2}$'
	)
);--> statement-breakpoint

ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Read by the nightly reconciler (which sweeps every subscription whose period
-- has ended) and by the dunning job (which sweeps by status). Both scan this
-- index rather than the table; neither is on a request path.
CREATE INDEX "org_subscriptions_status_period_idx"
	ON "org_subscriptions" USING btree ("status", "current_period_end");--> statement-breakpoint

-- ── org_usage_counters ──────────────────────────────────────────────────────
-- Secret fetches per organisation per billing period.
--
-- Not a count over audit_logs, for two reasons that both matter. Audit rows are
-- retained by plan and pruned, so billing arithmetic over them would change its
-- answer as history expired; and the audit table is append-only by grant, which
-- makes it the wrong shape for a counter that is updated in place.
--
-- **This table must never be written on the fetch path.** A fetch that costs an
-- extra UPDATE is a fetch that doubles its p99 to record a number nobody reads
-- in real time. Counts accumulate in the Worker and flush periodically; this is
-- the destination of the flush, not of the fetch.
--
-- The composite primary key is (org_id, period_start): one row per org per
-- period, and the insert is an upsert on exactly that.

CREATE TABLE "org_usage_counters" (
	"org_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"secret_fetches" bigint DEFAULT 0 NOT NULL,
	"metered_units_sent" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_usage_counters_pkey" PRIMARY KEY ("org_id", "period_start"),
	CONSTRAINT "org_usage_counters_fetches_check" CHECK ("org_usage_counters"."secret_fetches" >= 0),
	CONSTRAINT "org_usage_counters_units_check" CHECK ("org_usage_counters"."metered_units_sent" >= 0)
);--> statement-breakpoint

ALTER TABLE "org_usage_counters"
	ADD CONSTRAINT "org_usage_counters_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── billing_webhook_events ──────────────────────────────────────────────────
-- The idempotency gate for incoming payment webhooks.
--
-- Dodo retries a failed delivery eight times — immediately, then at 5s, 5min,
-- 30min, 2h, 5h and 10h — and will deliver duplicates. The primary key on
-- `webhook_id` IS the deduplication: the handler inserts first and processes
-- only if the insert won, inside one transaction.
--
-- A SELECT-then-INSERT would leave a window that two concurrent retries can
-- both pass through, and what lies on the other side of that window is a double
-- grant or a double charge. The constraint is the mechanism, not a backstop for
-- application code that already checked.
--
-- Created in this migration rather than alongside the handler that uses it,
-- because a missing migration is a worse thing to discover under deadline than
-- a missing handler is.

CREATE TABLE "billing_webhook_events" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" uuid
);--> statement-breakpoint

-- ON DELETE set null, not cascade: deleting an organisation must not erase the
-- record that we were told to charge it. The row's purpose is to prove a
-- delivery was already handled, and that remains true after the org is gone.
ALTER TABLE "billing_webhook_events"
	ADD CONSTRAINT "billing_webhook_events_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "billing_webhook_events_received_idx"
	ON "billing_webhook_events" USING btree ("received_at");--> statement-breakpoint

CREATE INDEX "billing_webhook_events_org_idx"
	ON "billing_webhook_events" USING btree ("org_id");--> statement-breakpoint

-- ── backfill ────────────────────────────────────────────────────────────────
-- Every existing organisation becomes Free, which is what it already is.
--
-- Soft-deleted organisations are included deliberately: restoring one must not
-- produce an organisation with no subscription row, and the alternative is a
-- left join with a fallback in the hot path forever.
INSERT INTO "org_subscriptions" ("org_id")
SELECT "id" FROM "organizations"
ON CONFLICT ("org_id") DO NOTHING;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new
-- table automatically, so the three tables above are invisible to it until this
-- runs. Guarded, because a self-hoster who never ran the least-privilege
-- migration has no such role and must not be blocked by its absence.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON org_subscriptions TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON org_usage_counters TO xecret_app_permissions;
		-- Insert and select only. A webhook receipt is a record that something
		-- was already handled; code that can delete one can replay a payment
		-- event, which is the single failure this table exists to prevent. Same
		-- reasoning as audit_logs, enforced the same way — by grant, not by
		-- convention.
		GRANT SELECT, INSERT ON billing_webhook_events TO xecret_app_permissions;
		REVOKE UPDATE, DELETE, TRUNCATE ON billing_webhook_events FROM xecret_app_permissions;
	END IF;
END
$$;
