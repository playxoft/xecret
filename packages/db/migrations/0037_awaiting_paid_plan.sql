-- One plan, one organisation: the free allowance, recorded where it is spent.
--
-- ── organizations.awaiting_paid_plan_since ──
-- A plan covers the one organisation it is bought for, and every account gets
-- two Free organisations that work (`FREE_ORGANIZATIONS_PER_ACCOUNT`). A Free
-- organisation past that waits for a paid plan: its control plane is closed
-- (every write refused but buying a plan, deleting it and taking access away),
-- its data plane is not (reads, CLI pulls and service-token fetches all keep
-- working), and nothing is deleted.
--
-- This column is that state, and when it began. It was first worked out on
-- every read from the order the creator's Free organisations were created in,
-- and a review found two faults in doing so. An older organisation lapsing back
-- to Free made a *younger* one that worked yesterday start waiting, under
-- people who were never told why. And removing or suspending the creator took
-- an organisation out of the count altogether, so the allowance could be
-- stepped round by leaving. Stored, it changes only at the moments the rule is
-- about, and only on the organisation concerned:
--
--   set     when an organisation is created while its creator already has two
--           open Free organisations they created; and when an organisation
--           drops back to Free (a subscription ending, a grant ending, an
--           operator setting Free) while its creator has two *other* open Free
--           ones. The one dropping back goes to the back of the queue; no other
--           organisation ever changes.
--   cleared when the organisation is bought a plan or given a grant.
--
-- "Open" means Free with this column null, created by that account, whether or
-- not the creator is still a member of it. A membership change (the creator
-- removed, suspended or re-added, ownership moving) never sets or clears it.
-- Where this deployment takes no payments the rule does not apply at all: no
-- organisation is created waiting, and a stored value is not read.
--
-- ── Read this before running it ──
-- Additive only: one nullable column, no default, so every existing row is
-- NULL and nothing that works today starts waiting when this is applied. The
-- production data checked on 2026-11-28 had no account holding more than one
-- Free organisation it created, so no row needed setting.
--
-- Apply it BEFORE the build that reads it: that build's tenancy lookup, which
-- every request under an organisation makes, selects the column.
--
-- No grant is needed: the application role's table-wide privileges on
-- `organizations` (0002) cover the new column, as they did 0021's.

ALTER TABLE "organizations" ADD COLUMN "awaiting_paid_plan_since" timestamp with time zone;--> statement-breakpoint

-- ── billing_reminders: the email an organisation that starts waiting sends ──
--   awaiting_paid_plan   an organisation dropped back to Free past its
--                        creator's allowance, and waits for a paid plan.
--                        Occasion: the day it started waiting.
ALTER TABLE "billing_reminders" DROP CONSTRAINT "billing_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "billing_reminders"
	ADD CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN (
		'trial_ending_3d', 'trial_ending_1d', 'payment_failed', 'card_expiring',
		'renewal_upcoming', 'seats_changed', 'usage_80', 'usage_100', 'invoice_available',
		'plan_ended_unpaid', 'grant_ending_7d', 'grant_ending_1d', 'grant_ended',
		'awaiting_paid_plan',
		'alert_unknown_product', 'alert_activation_waiting', 'alert_operator_managed'
	));
