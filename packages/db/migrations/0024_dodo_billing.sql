-- Payments through Dodo (P12): what the webhooks write, and the four ledgers
-- the billing jobs keep beside them.
--
-- ── Read this before running it ──
-- Additive only. Four columns on `org_subscriptions`, all nullable, and five new
-- tables. Nothing existing changes shape and no row is rewritten, so applying
-- this ahead of the build that uses it is harmless: the previous release never
-- reads or writes any of it.
--
-- Apply it BEFORE deploying the P12 build. Every `select()` on
-- `org_subscriptions` from that build names the new columns, so a request that
-- loads a subscription fails against a database without them — and that is
-- every request that resolves an organisation.
--
-- ── org_subscriptions: four columns the webhooks fill ──
--
--   current_period_start  The start of the paid period, from the provider's
--                         `previous_billing_date`. The usage counter is keyed by
--                         it, so the meter's period and the invoice's period are
--                         the same period.
--   dodo_product_id       The product the subscription is on. Kept rather than
--                         re-derived from plan + interval: a seat change has to
--                         name the product the customer actually holds, and a
--                         catalog that moved since checkout must not move them.
--   dodo_event_at         The provider timestamp of the last subscription
--                         snapshot applied. A snapshot older than this one is
--                         stale — webhooks arrive out of order, and a `renewed`
--                         delivered before an `active` must not be overwritten
--                         by it.
--   renewal_amount_minor  What the next renewal charges, before tax, in the
--                         currency's smallest unit — the figure the seven-day
--                         renewal notice quotes. Never read for access.
ALTER TABLE "org_subscriptions" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_product_id" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "dodo_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "renewal_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "org_subscriptions"
	ADD CONSTRAINT "org_subscriptions_renewal_amount_check"
	CHECK ("renewal_amount_minor" IS NULL OR "renewal_amount_minor" >= 0);--> statement-breakpoint

-- A webhook names the customer before the organisation sometimes, and the
-- reconciler and the usage flush read by customer. Partial: most rows have none.
CREATE INDEX "org_subscriptions_dodo_customer_idx"
	ON "org_subscriptions" USING btree ("dodo_customer_id")
	WHERE "dodo_customer_id" IS NOT NULL;--> statement-breakpoint

-- ── billing_checkouts ───────────────────────────────────────────────────────
-- Every hosted checkout an owner was sent to, by the provider's session id.
--
-- The way back from a payment to the organisation that started it: a payment
-- event carries the checkout session id, and this row says whose it was. The
-- organisation is never taken from anything the browser sent — the session id
-- was minted by our own server call, and this row was written by it.
--
-- `plan` and `billing_interval` are what the server chose, recorded so a
-- dispute about "I asked for monthly" has an answer. Insert and select only:
-- a checkout that happened cannot be edited into one that did not.
CREATE TABLE "billing_checkouts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"plan" "plan_id" NOT NULL,
	"billing_interval" "billing_interval" NOT NULL,
	"quantity" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkouts_quantity_check" CHECK ("quantity" >= 1),
	-- Free is never bought.
	CONSTRAINT "billing_checkouts_plan_check" CHECK ("plan" <> 'free'),
	CONSTRAINT "billing_checkouts_session_id_check" CHECK (length("session_id") BETWEEN 1 AND 255)
);--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_checkouts_org_idx" ON "billing_checkouts" USING btree ("org_id", "created_at");--> statement-breakpoint

-- ── billing_seat_syncs ──────────────────────────────────────────────────────
-- Seat changes still owed to the payment provider.
--
-- When membership changes, the new seat count is pushed to Dodo **after** the
-- membership transaction commits — never inside it, where a network call would
-- hold the organisation's row lock for as long as Dodo took to answer. This row
-- is written first, so a push that fails, times out, or dies with the isolate
-- leaves a debt the hourly job collects. It holds no count: the job always
-- pushes the count as it is *then*, never one remembered from earlier.
CREATE TABLE "billing_seat_syncs" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	-- A category, e.g. `upstream_5xx`, never a provider message.
	"last_error" text,
	CONSTRAINT "billing_seat_syncs_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "billing_seat_syncs_last_error_check" CHECK ("last_error" IS NULL OR length("last_error") <= 64)
);--> statement-breakpoint
ALTER TABLE "billing_seat_syncs" ADD CONSTRAINT "billing_seat_syncs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── billing_reminders ───────────────────────────────────────────────────────
-- Which billing emails have gone out, so none goes out twice.
--
-- The primary key is the deduplication, the same way `billing_webhook_events`
-- deduplicates deliveries: a reminder is sent only by the job that won the
-- insert. `occasion` names the thing being reminded about — a trial's end date,
-- a period's start, a payment — so the next trial or the next period gets its
-- own reminder and this one never repeats.
CREATE TABLE "billing_reminders" (
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occasion" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reminders_pkey" PRIMARY KEY ("org_id", "kind", "occasion"),
	CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN (
		'trial_ending_3d', 'trial_ending_1d', 'payment_failed', 'card_expiring',
		'renewal_upcoming', 'seats_changed', 'usage_80', 'usage_100', 'invoice_available'
	)),
	CONSTRAINT "billing_reminders_occasion_check" CHECK (length("occasion") BETWEEN 1 AND 128)
);--> statement-breakpoint
ALTER TABLE "billing_reminders" ADD CONSTRAINT "billing_reminders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_reminders_sent_idx" ON "billing_reminders" USING btree ("sent_at");--> statement-breakpoint

-- ── billing_license_keys ────────────────────────────────────────────────────
-- Self-host licence keys the provider issued (`license_key.created`), stored
-- against the order for the P22 licence page.
--
-- **The key itself is not here.** The provider generates it and emails it to
-- the buyer; this row is the record that it exists — which product, which
-- order, how many activations, until when. A licence key in this table would be
-- a credential in a database that does not need one.
CREATE TABLE "billing_license_keys" (
	"license_key_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"dodo_customer_id" text,
	"dodo_subscription_id" text,
	"dodo_payment_id" text,
	"activations_limit" integer,
	"expires_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_license_keys_activations_check" CHECK ("activations_limit" IS NULL OR "activations_limit" >= 0)
);--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The new columns inherit `org_subscriptions`' table privileges (0016). The new
-- tables are granted nothing automatically (0010 revoked the defaults), so each
-- is granted here — as narrowly as its job allows — guarded as before for a
-- self-hoster without the role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		-- Records of what happened: written once, read, never edited away.
		GRANT SELECT, INSERT ON billing_checkouts TO xecret_app_permissions;
		REVOKE UPDATE, DELETE, TRUNCATE ON billing_checkouts FROM xecret_app_permissions;
		GRANT SELECT, INSERT ON billing_license_keys TO xecret_app_permissions;
		REVOKE UPDATE, DELETE, TRUNCATE ON billing_license_keys FROM xecret_app_permissions;
		-- A debt is paid by deleting it, and retried by updating it.
		GRANT SELECT, INSERT, UPDATE, DELETE ON billing_seat_syncs TO xecret_app_permissions;
		-- Sent reminders are only ever inserted, and pruned once their occasion
		-- is long past.
		GRANT SELECT, INSERT, DELETE ON billing_reminders TO xecret_app_permissions;
		REVOKE UPDATE, TRUNCATE ON billing_reminders FROM xecret_app_permissions;
	END IF;
END
$$;
