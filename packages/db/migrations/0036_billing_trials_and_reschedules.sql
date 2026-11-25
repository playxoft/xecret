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
-- ── billing_seat_syncs: a scheduled change a seat push replaced ──
-- While Dodo has a plan change scheduled (a downgrade waiting for the renewal)
-- it refuses any other change-plan with a 409, so a seat increase used to wait
-- for the change — up to a year on a yearly plan, unbilled. A seat increase is
-- now pushed at once with `cancel_scheduled_change_plan`, which cancels the
-- scheduled change in the same Dodo transaction, and the scheduled change is
-- then made again at the new seat count. `reschedule_product_id` is that owed
-- re-scheduling, written BEFORE the push so that an isolate lost between the
-- two calls leaves it for the hourly job instead of silently dropping the
-- owner's downgrade; `reschedule_at` is when the replaced change was due, for
-- the alert if it can never be made again.
--
-- ── Read this before running it ──
-- Additive only: one new table, two nullable columns, one constraint. Apply it
-- BEFORE the build that reads it — that build's every whole-row query of
-- `billing_seat_syncs` names the new columns (the seat sync after every
-- membership change, the hourly job, the reconciler), and every applied
-- subscription snapshot inserts into `billing_trials`.

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

ALTER TABLE "billing_seat_syncs" ADD CONSTRAINT "billing_seat_syncs_reschedule_product_check"
	CHECK ("reschedule_product_id" is null or length("reschedule_product_id") between 1 and 255);--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The new columns inherit `billing_seat_syncs`' table privileges (0024). The
-- new table is granted nothing automatically (0010 revoked the defaults), so
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
