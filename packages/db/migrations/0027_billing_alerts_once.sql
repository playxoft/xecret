-- Payments through Dodo (P12), round 3 of review: an alert the billing jobs
-- raise once, not every hour.
--
-- ── Read this before running it ──
-- One constraint widened, nothing else: `billing_reminders` accepts three more
-- kinds. Apply it BEFORE the build that writes them, after 0026. The previous
-- build never writes them, so applying this first is harmless.
--
-- ── billing_reminders: alerts, raised once ──
-- The ledger's primary key — organisation, kind, occasion — is what makes a
-- billing email go out once. The same key now does that for three error lines
-- for a human, which the hourly job would otherwise repeat every run for as
-- long as their cause lasts. Nothing is emailed for these kinds.
--
--   alert_unknown_product     A subscription the job asked Dodo about is on a
--                             product this deployment does not sell. Occasion:
--                             the subscription and the product.
--   alert_activation_waiting  A paid checkout's subscription, a day after its
--                             payment linked it, is still pending at Dodo or
--                             unknown to it. Occasion: the subscription.
--   alert_operator_managed    A paid row follows a subscription id with no
--                             product recorded: an operator's grant written
--                             over an old subscription's id. Occasion: the
--                             subscription.
--
-- The grants are 0024's — insert and delete, never update — and cover the new
-- kinds as they cover the old: a claimed alert is never un-claimed, only pruned
-- with the reminders after a year.
ALTER TABLE "billing_reminders" DROP CONSTRAINT "billing_reminders_kind_check";--> statement-breakpoint
ALTER TABLE "billing_reminders"
	ADD CONSTRAINT "billing_reminders_kind_check" CHECK ("kind" IN (
		'trial_ending_3d', 'trial_ending_1d', 'payment_failed', 'card_expiring',
		'renewal_upcoming', 'seats_changed', 'usage_80', 'usage_100', 'invoice_available',
		'plan_ended_unpaid',
		'alert_unknown_product', 'alert_activation_waiting', 'alert_operator_managed'
	));
