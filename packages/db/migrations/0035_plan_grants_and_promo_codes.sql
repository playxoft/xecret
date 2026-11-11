-- Complimentary plans and promo codes: what xecret's own admins hand out, from
-- the admin page (`/app/admin`) or `npm run plan:set` — and who those admins
-- are.
--
-- ── Read this before running it ──
-- Additive only: two columns on `org_subscriptions`, one on
-- `billing_checkouts`, four new tables, and `billing_reminders` accepting three
-- more kinds. Nobody is an admin afterwards: the first one is added by an
-- operator, `phase run --env Production -- npm run admin -- --add <address>`. The build that ships with it reads the new columns on every
-- billing screen and admin page, so apply this BEFORE that build is deployed.
-- The previous build never reads or writes any of it, so applying it first is
-- harmless.
--
-- ── org_subscriptions: a grant can end ──
-- An operator's grant — a paid plan with no Dodo subscription behind it
-- (`operatorManaged`) — used to last until somebody changed it by hand.
-- `grant_ends_at` is when the hourly job returns it to Free; `null` is a grant
-- with no end, exactly as before. `grant_note` is the one line the billing
-- screen and the admin page show about where it came from ("Promo code
-- FRIENDS", "Granted by support"); the reason itself lives in the audit row.
--
-- The CHECK is the meaning, stated where no code path can disagree with it: an
-- end date belongs to a grant, so a row on Free, or one Dodo bills, can never
-- carry one. The webhook only ever attaches a subscription to a Free row, so it
-- never meets one either.
ALTER TABLE "org_subscriptions" ADD COLUMN "grant_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "grant_note" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_grant_ends_check"
	CHECK ("grant_ends_at" IS NULL OR ("plan" <> 'free' AND "dodo_subscription_id" IS NULL));--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_grant_note_check"
	CHECK ("grant_note" IS NULL OR length("grant_note") BETWEEN 1 AND 200);--> statement-breakpoint
-- The hourly sweep: grants due to end, and the reminders before they do.
CREATE INDEX "org_subscriptions_grant_ends_idx"
	ON "org_subscriptions" USING btree ("grant_ends_at")
	WHERE "grant_ends_at" IS NOT NULL;--> statement-breakpoint

-- ── promo_codes ──
-- A code an admin made, of one of two kinds:
--
--   grant      Redeemed in the app, by an owner: the organisation gets
--              `grant_plan` for `grant_days` days (or for good), with no card
--              and nothing at Dodo. Counted here (`redemptions`), atomically.
--   discount   Applied to a checkout: a Dodo discount code (`dodo_discount_id`,
--              in `dodo_mode`) restricted to xecret's own products, which the
--              server pre-applies after checking it here. Dodo's own code box
--              is hidden, so a code works only through this check.
--
-- `allowed_emails` limits who may use a code (lower-cased; `null` is anybody
-- holding it). `code` is what Dodo accepts — upper-case letters and digits, 3
-- to 16 — and stays unique for ever, revoked or not, so a code once handed out
-- can never come to mean something else.
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"grant_plan" "plan_id",
	"grant_days" integer,
	"grant_seats" integer,
	"discount_type" text,
	"discount_amount" integer,
	"discount_currency" text,
	"discount_cycles" integer,
	"discount_plans" "plan_id"[],
	"dodo_discount_id" text,
	"dodo_mode" text,
	"allowed_emails" text[],
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "promo_codes_code_check" CHECK ("code" ~ '^[A-Z0-9]{3,16}$'),
	CONSTRAINT "promo_codes_kind_check" CHECK ("kind" IN ('grant', 'discount')),
	CONSTRAINT "promo_codes_description_check"
		CHECK ("description" IS NULL OR length("description") BETWEEN 1 AND 200),
	CONSTRAINT "promo_codes_grant_check" CHECK (
		"kind" <> 'grant' OR (
			"grant_plan" IS NOT NULL AND "grant_plan" NOT IN ('free', 'scale')
			AND ("grant_days" IS NULL OR "grant_days" BETWEEN 1 AND 3650)
			AND ("grant_seats" IS NULL OR "grant_seats" BETWEEN 1 AND 100000)
			AND "discount_type" IS NULL AND "discount_amount" IS NULL
			AND "discount_currency" IS NULL AND "discount_cycles" IS NULL
			AND "discount_plans" IS NULL AND "dodo_discount_id" IS NULL AND "dodo_mode" IS NULL
		)
	),
	CONSTRAINT "promo_codes_discount_check" CHECK (
		"kind" <> 'discount' OR (
			"grant_plan" IS NULL AND "grant_days" IS NULL AND "grant_seats" IS NULL
			AND "dodo_discount_id" IS NOT NULL AND length("dodo_discount_id") BETWEEN 1 AND 255
			AND "dodo_mode" IN ('test_mode', 'live_mode')
			AND "discount_plans" IS NOT NULL AND cardinality("discount_plans") BETWEEN 1 AND 2
			AND "discount_plans" <@ ARRAY['pro', 'team']::"plan_id"[]
			AND ("discount_cycles" IS NULL OR "discount_cycles" BETWEEN 1 AND 120)
			AND (
				("discount_type" = 'percentage' AND "discount_amount" BETWEEN 1 AND 10000
					AND "discount_currency" IS NULL)
				OR ("discount_type" = 'flat' AND "discount_amount" BETWEEN 1 AND 100000000
					AND "discount_currency" ~ '^[A-Z]{3}$')
			)
		)
	),
	CONSTRAINT "promo_codes_allowed_emails_check"
		CHECK ("allowed_emails" IS NULL OR cardinality("allowed_emails") BETWEEN 1 AND 100),
	CONSTRAINT "promo_codes_max_redemptions_check"
		CHECK ("max_redemptions" IS NULL OR "max_redemptions" BETWEEN 1 AND 100000),
	CONSTRAINT "promo_codes_redemptions_check" CHECK (
		"redemptions" >= 0 AND ("max_redemptions" IS NULL OR "redemptions" <= "max_redemptions")
	),
	CONSTRAINT "promo_codes_revoked_check"
		CHECK ("revoked_by" IS NULL OR "revoked_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_created_by_users_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_revoked_by_users_id_fk"
	FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_codes_created_idx" ON "promo_codes" USING btree ("created_at");--> statement-breakpoint

-- ── promo_code_redemptions ──
-- Which organisation redeemed which grant code, and who did it. The primary key
-- is the rule "once per organisation"; the unique index is "once per person",
-- so one owner cannot collect a code's free months on every organisation they
-- create. Append-only: a redemption happened, and is never edited into
-- something else. It goes with its organisation by the cascade.
CREATE TABLE "promo_code_redemptions" (
	"code_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_code_redemptions_pkey" PRIMARY KEY("code_id", "org_id")
);--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_code_id_promo_codes_id_fk"
	FOREIGN KEY ("code_id") REFERENCES "public"."promo_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_code_redemptions_user_unique"
	ON "promo_code_redemptions" USING btree ("code_id", "user_id")
	WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "promo_code_redemptions_org_idx"
	ON "promo_code_redemptions" USING btree ("org_id");--> statement-breakpoint

-- ── billing_checkouts: which code a checkout carried ──
-- Written with the checkout, never after: the column is covered by the table's
-- INSERT grant, and 0025's column-level UPDATE grant does not reach it.
ALTER TABLE "billing_checkouts" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_promo_code_id_promo_codes_id_fk"
	FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_checkouts_promo_code_idx"
	ON "billing_checkouts" USING btree ("promo_code_id")
	WHERE "promo_code_id" IS NOT NULL;--> statement-breakpoint

-- ── billing_reminders: a grant ending ──
--   grant_ending_7d, grant_ending_1d   before a grant's end date. Occasion: the
--                                      date, so an extension reminds again.
--   grant_ended                        the organisation is back on Free.
ALTER TABLE "billing_reminders" DROP CONSTRAINT "billing_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "billing_reminders"
	ADD CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN (
		'trial_ending_3d', 'trial_ending_1d', 'payment_failed', 'card_expiring',
		'renewal_upcoming', 'seats_changed', 'usage_80', 'usage_100', 'invoice_available',
		'plan_ended_unpaid', 'grant_ending_7d', 'grant_ending_1d', 'grant_ended',
		'alert_unknown_product', 'alert_activation_waiting', 'alert_operator_managed'
	));--> statement-breakpoint

-- ── platform_admins ──
-- xecret's own staff: who may open the admin page. One row per admin, keyed by
-- the account rather than an address, so it means exactly the person who
-- signed in — an account deleted takes its row with it. Added and removed from
-- the admin page by another admin (never the last one), or by an operator with
-- `npm run admin` — which is how the first one is made.
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_added_by_users_id_fk"
	FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── platform_admin_changes ──
-- Every admin added or removed, by whom, and when — the record a removed row
-- cannot keep. The address is a copy taken at the time, so the history still
-- reads after the account itself is gone. Never shown to a customer.
-- Append-only.
CREATE TABLE "platform_admin_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"by_user_id" uuid,
	"by_label" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admin_changes_action_check" CHECK ("action" IN ('added', 'removed')),
	CONSTRAINT "platform_admin_changes_email_check" CHECK (length("email") BETWEEN 3 AND 320),
	CONSTRAINT "platform_admin_changes_by_label_check"
		CHECK ("by_label" IS NULL OR length("by_label") BETWEEN 1 AND 128),
	CONSTRAINT "platform_admin_changes_by_check"
		CHECK ("by_user_id" IS NOT NULL OR "by_label" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "platform_admin_changes" ADD CONSTRAINT "platform_admin_changes_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admin_changes" ADD CONSTRAINT "platform_admin_changes_by_user_id_users_id_fk"
	FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_admin_changes_at_idx" ON "platform_admin_changes" USING btree ("at");--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- A code is inserted, and afterwards only counted and revoked: three columns,
-- never the code, its kind or what it gives. No DELETE — a code handed out
-- stays on record. A redemption is a record and is only ever inserted. An
-- admin is added and removed, never edited; the history of both only grows.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT ON promo_codes TO xecret_app_permissions;
		GRANT UPDATE ("redemptions", "revoked_at", "revoked_by") ON promo_codes TO xecret_app_permissions;
		GRANT SELECT, INSERT ON promo_code_redemptions TO xecret_app_permissions;
		GRANT SELECT, INSERT, DELETE ON platform_admins TO xecret_app_permissions;
		GRANT SELECT, INSERT ON platform_admin_changes TO xecret_app_permissions;
	END IF;
END
$$;
