-- Two billing fixes from a security review (2026-11-25).
--
-- ── billing_trials: a free trial is had once ──
-- Team's Dodo product carries a 14-day trial, and every checkout by email
-- creates a new Dodo customer (`always_create_new_customer` — one customer per
-- organisation, so one owner's two organisations never share a portal). Dodo's
-- own trial-misuse protection is per customer, so it never sees the second
-- trial: an organisation could trial, let the subscription go on hold with no
-- card, fall back to Free, and check out again for another trial — and the
-- members invited meanwhile keep their seats on Free.
--
-- One row per Dodo subscription that started on a trial, written when its
-- snapshot is applied: the organisation, the account whose checkout started it
-- (`billing_checkouts.created_by`) and the Dodo mode it belongs to. A later
-- checkout for that organisation, or by that account (or by any account with
-- the same address) for any organisation, asks Dodo for no trial
-- (`subscription_data.trial_period_days: 0`). Only trials of the deployment's
-- own Dodo mode count, so a staging rehearsal never spends a live trial.
--
-- Both references are `ON DELETE SET NULL`, never cascade: an organisation is
-- purged thirty days after it is deleted, and the account that trialed it must
-- not be given a fresh trial by that purge. The row is a record of what
-- happened — inserted, read, never edited (the foreign keys' SET NULL runs as
-- the owner, not as the application).
--
-- ── billing_checkouts.trial_mode: a trial on its way ──
-- `billing_trials` is written when a trial's snapshot arrives, and a checkout
-- stays attachable for a week — so one account opening checkouts for several
-- organisations at once, before any of them is paid, would have had a trial
-- in each. A checkout that may start a trial (it did not ask Dodo for none)
-- records the Dodo mode it was made in; an open, unspent one counts as a trial
-- had, for the account that made it and for its organisation. Null: it asked
-- for none. Set by the insert; the application still updates only the two
-- consumption columns.
--
-- ── billing_seat_syncs: a scheduled change a seat push replaced ──
-- While Dodo has a plan change scheduled (a downgrade waiting for the renewal)
-- it refuses any other change-plan with a 409, so a seat increase used to wait
-- for the change — up to a year on a yearly plan, unbilled. A seat increase is
-- now pushed at once with `cancel_scheduled_change_plan`, which cancels the
-- scheduled change in the same Dodo transaction, and the scheduled change is
-- then made again at the new seat count. `reschedule_product_id` is that owed
-- re-scheduling, written BEFORE the push so that an isolate lost between the
-- two calls leaves it for the hourly job instead of silently dropping the
-- owner's downgrade; `reschedule_at` is when the replaced change was due.
--
-- What the push was made against, so the owed change is made again only onto
-- the subscription it was owed for: `reschedule_from_product_id` (the product
-- the subscription was on — a later upgrade moves it, and the old downgrade
-- must not land on the new plan), and the seat counts before and after the
-- push (`reschedule_from_seats`, `reschedule_to_seats`). A push Dodo did not
-- answer may or may not have applied; `reschedule_confirmed_at` is null until
-- it is known that it did, and Dodo's own count settles it before anything
-- else is pushed: still at the count before, with the scheduled change gone,
-- is a push that never applied and a change withdrawn meanwhile — not one to
-- make again.
--
-- ── Read this before running it ──
-- Additive only: one new table, nullable columns on two tables, two
-- constraints. Apply it BEFORE the build that reads it — that build's every
-- whole-row query of `billing_seat_syncs` and `billing_checkouts` names the new
-- columns (the seat sync after every membership change, the hourly job, the
-- reconciler, checkout and the webhook), and every applied subscription
-- snapshot inserts into `billing_trials`.

CREATE TABLE "billing_trials" (
	"subscription_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"dodo_mode" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_trials_subscription_id_check"
		CHECK (length("subscription_id") between 1 and 255),
	CONSTRAINT "billing_trials_dodo_mode_check" CHECK ("dodo_mode" in ('test_mode', 'live_mode'))
);--> statement-breakpoint

ALTER TABLE "billing_trials" ADD CONSTRAINT "billing_trials_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "billing_trials" ADD CONSTRAINT "billing_trials_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The two questions a checkout asks: has this organisation trialed, has this
-- account? (The address is asked through `users`, by its own unique index.)
CREATE INDEX "billing_trials_org_idx" ON "billing_trials" USING btree ("org_id")
	WHERE "org_id" is not null;--> statement-breakpoint

CREATE INDEX "billing_trials_user_idx" ON "billing_trials" USING btree ("user_id")
	WHERE "user_id" is not null;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_product_id" text;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_from_product_id" text;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_from_seats" integer;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_to_seats" integer;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD COLUMN "reschedule_confirmed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "billing_seat_syncs" ADD CONSTRAINT "billing_seat_syncs_reschedule_product_check"
	CHECK (
		("reschedule_product_id" is null or length("reschedule_product_id") between 1 and 255)
		and ("reschedule_from_product_id" is null
			or length("reschedule_from_product_id") between 1 and 255)
	);--> statement-breakpoint

ALTER TABLE "billing_checkouts" ADD COLUMN "trial_mode" text;--> statement-breakpoint

ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_trial_mode_check"
	CHECK ("trial_mode" is null or "trial_mode" in ('test_mode', 'live_mode'));--> statement-breakpoint

-- The open checkouts an account has made: what a checkout asks before it lets
-- Dodo start a trial (`trialAlreadyUsed`).
CREATE INDEX "billing_checkouts_created_by_idx" ON "billing_checkouts" USING btree ("created_by")
	WHERE "trial_mode" is not null and "subscription_id" is null;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The new columns inherit their tables' privileges: `billing_seat_syncs`'
-- table-wide ones (0024), and `billing_checkouts`' insert and read — its column
-- UPDATE grant (0025) names the two consumption columns only, so `trial_mode`
-- is written once, by the insert. The new table is granted nothing
-- automatically (0010 revoked the defaults), so
-- it is granted here — read and insert, a record — guarded as before for a
-- self-hoster without the role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT ON billing_trials TO xecret_app_permissions;
		REVOKE UPDATE, DELETE, TRUNCATE ON billing_trials FROM xecret_app_permissions;
	END IF;
END
$$;
