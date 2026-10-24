-- Payments through Dodo (P12), round 1 of review: what 0024 could not say.
--
-- ── Read this before running it ──
-- Additive only: seven nullable columns on `org_subscriptions`, three nullable
-- columns on `billing_checkouts`, four columns on `billing_seat_syncs` (one with
-- a default), one more reminder kind, and one new table. One backfill, of a
-- column nothing has read yet. Apply it BEFORE the build that uses it, after
-- 0024 — the build's whole-row reads of these tables name the new columns.
--
-- ── org_subscriptions ──
--
--   metered_from           The first moment this subscription's usage may be
--                          billed: its activation, or its trial's end when it
--                          had one. The overage report meters only counter rows
--                          whose period starts at or after it — so fetches made
--                          on Free, or during a trial, are never billed by the
--                          subscription that came after them.
--   dodo_mode              Which Dodo the row's ids belong to: `test_mode` or
--                          `live_mode`. A deployment refuses to apply an event
--                          from one mode to a row from the other, and its jobs
--                          never call Dodo for a row of the other mode.
--   dodo_event_id          The webhook id of the last snapshot applied, so two
--                          snapshots with the same provider timestamp are
--                          ordered the same way whichever arrives first.
--   on_hold_since          When the subscription last went on hold. One on hold
--                          for fourteen days is ended locally by the hourly job.
--   dodo_scheduled_change_at  When a plan change Dodo has scheduled takes effect
--                          (a downgrade waits for the period end). A seat push
--                          would collide with it, so the push waits too.
--   dodo_currency          The currency and billing country Dodo last reported,
--   dodo_billing_country   whatever the region lock kept in `currency` and
--                          `billing_country`. The renewal amount is in Dodo's
--                          currency, and a region disagreement is raised once,
--                          when Dodo's report changes, not on every snapshot.
ALTER TABLE "org_subscriptions" ADD COLUMN "metered_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_mode" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_event_id" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "on_hold_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_scheduled_change_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_currency" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_billing_country" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_dodo_mode_check"
	CHECK ("dodo_mode" IS NULL OR "dodo_mode" IN ('test_mode', 'live_mode'));--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_dodo_event_id_check"
	CHECK ("dodo_event_id" IS NULL OR length("dodo_event_id") BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_dodo_currency_check"
	CHECK ("dodo_currency" IS NULL OR "dodo_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_dodo_country_check"
	CHECK ("dodo_billing_country" IS NULL OR "dodo_billing_country" ~ '^[A-Z]{2}$');--> statement-breakpoint

-- The one backfill. A subscription Dodo already bills meters from its current
-- period, or its trial's end if that is later: every earlier period is left
-- unbilled, which can only under-count. Nothing reads the column before this
-- build, so the order of this and the deploy does not matter.
UPDATE "org_subscriptions"
	SET "metered_from" = greatest("current_period_start", "trial_ends_at")
	WHERE "dodo_subscription_id" IS NOT NULL AND "plan" <> 'free';--> statement-breakpoint

-- ── billing_checkouts: the nonce that binds a subscription to its checkout ──
--
--   nonce            Random, minted by our server for each checkout and sent
--                    to Dodo as metadata. A subscription is attached to an
--                    organisation by its metadata only when it carries the
--                    nonce of an open checkout of that organisation — so a
--                    purchase made anywhere else (a static payment link with
--                    our organisation id typed into its metadata) attaches to
--                    nothing.
--   subscription_id  The subscription the checkout produced, once one did.
--   consumed_at      When. A consumed checkout attaches nothing more.
--
-- Still insert-only as a table: the application may set these two columns and
-- no other, exactly as it may update only `retained_vaults`' bookkeeping.
ALTER TABLE "billing_checkouts" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_checkouts"
	ADD CONSTRAINT "billing_checkouts_nonce_check"
	CHECK ("nonce" IS NULL OR length("nonce") BETWEEN 16 AND 128);--> statement-breakpoint
ALTER TABLE "billing_checkouts"
	ADD CONSTRAINT "billing_checkouts_subscription_id_check"
	CHECK ("subscription_id" IS NULL OR length("subscription_id") BETWEEN 1 AND 255);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkouts_nonce_unique" ON "billing_checkouts" USING btree ("nonce")
	WHERE "nonce" IS NOT NULL;--> statement-breakpoint

-- ── billing_seat_syncs: one push at a time, and a debt that cannot starve ──
--
--   generation        Bumped by every membership change, inside the
--                     membership's own transaction. A push clears the debt
--                     only if the generation it counted under is still the
--                     current one — so a change that lands mid-push is never
--                     cleared by the push that missed it.
--   claimed_until     A lease: the one push in flight for this organisation.
--                     A second push finds it held and leaves the debt to the
--                     holder, which re-counts before it lets go.
--   not_before        When the debt may next be tried: the retry backoff, or
--                     the end of a scheduled plan change a push would collide
--                     with. The hourly job reads only debts that are due.
--   dead_lettered_at  Given up on after too many failures, and raised once
--                     for a human. Still a debt — the reconciler reports it —
--                     but no longer retried, so it cannot crowd out new ones.
ALTER TABLE "billing_seat_syncs" ADD COLUMN "generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_seat_syncs" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_seat_syncs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_seat_syncs" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_seat_syncs"
	ADD CONSTRAINT "billing_seat_syncs_generation_check" CHECK ("generation" >= 1);--> statement-breakpoint

-- ── billing_reminders: one more email ──
-- `plan_ended_unpaid`: a subscription on hold for fourteen days, ended here.
ALTER TABLE "billing_reminders" DROP CONSTRAINT "billing_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "billing_reminders"
	ADD CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN (
		'trial_ending_3d', 'trial_ending_1d', 'payment_failed', 'card_expiring',
		'renewal_upcoming', 'seats_changed', 'usage_80', 'usage_100', 'invoice_available',
		'plan_ended_unpaid'
	));--> statement-breakpoint

-- ── billing_requests ────────────────────────────────────────────────────────
-- An owner's checkout or plan change, by the idempotency key the billing screen
-- sent with it. A second request with the same key gets the first one's answer
-- instead of a second checkout or a second change at Dodo — a double click, or
-- a browser retrying a request whose answer it never saw. `fingerprint` is
-- what was asked for (plan and interval), so a key reused for a different
-- request is refused rather than answered with the wrong result. Pruned after
-- a day by the hourly job.
CREATE TABLE "billing_requests" (
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_requests_pkey" PRIMARY KEY ("org_id", "kind", "idempotency_key"),
	CONSTRAINT "billing_requests_kind_check" CHECK ("kind" IN ('checkout', 'change')),
	CONSTRAINT "billing_requests_key_check" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "billing_requests_fingerprint_check" CHECK (length("fingerprint") BETWEEN 1 AND 64)
);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_requests_created_idx" ON "billing_requests" USING btree ("created_at");--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- New columns inherit their table's privileges; `billing_checkouts` gains the
-- two columns a consumption writes, and nothing else. The new table is granted
-- here, guarded as before for a self-hoster without the role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT UPDATE ("subscription_id", "consumed_at") ON billing_checkouts TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON billing_requests TO xecret_app_permissions;
	END IF;
END
$$;
