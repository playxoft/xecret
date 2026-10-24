-- Payments through Dodo (P12), round 2 of review: a usage month remembers the
-- allowance it was counted against.
--
-- ── Read this before running it ──
-- Additive only: one nullable column on `org_usage_counters`, and one
-- backfill of it. Apply it BEFORE the build that reads it, after 0025 — the
-- build's flush writes the column and its meter reads it. The previous build
-- never reads or writes it, so applying this first is harmless.
--
-- ── org_usage_counters.included_fetches ──
-- The fetches the plan included for that month, as it stood when the month
-- opened: the plan's own `includedFetchesPerMonth` with any support raise of
-- it (`limit_overrides`, raise-only). Written by the flush that opens the
-- month, and raised — never lowered — by a later flush while the month is
-- still the current one, so a mid-month raise from support counts for the
-- month it was granted in.
--
-- The overage meter bills a month against this figure and nothing else. Read
-- from the plan as it is today instead, an old month was re-billed at whatever
-- the organisation moved to since: a Team month, after a downgrade to Pro at
-- renewal, was billed as if it had only ever included Pro's 200,000; a month
-- support had raised was billed in full once the raise was cleared. A month
-- with no figure (none written by this build is) is never metered.
ALTER TABLE "org_usage_counters" ADD COLUMN "included_fetches" bigint;--> statement-breakpoint
ALTER TABLE "org_usage_counters"
	ADD CONSTRAINT "org_usage_counters_included_check"
	CHECK ("included_fetches" IS NULL OR "included_fetches" >= 0);--> statement-breakpoint

-- The one backfill: every existing month gets the allowance of the plan its
-- organisation is on now, which is the figure the meter used for it until
-- this build. The plans' allowances (`includedFetchesPerMonth` in
-- packages/core/src/entitlements/plans.ts) — free 20,000, pro 200,000, team
-- 1,000,000, enterprise 10,000,000; `scale`, withdrawn, resolves to team — and
-- a support override of it where it is a number and larger. Capped at the
-- largest integer a JavaScript number holds exactly, which is how it is read.
UPDATE "org_usage_counters" AS "counter"
	SET "included_fetches" = greatest(
		CASE "subscription"."plan"::text
			WHEN 'free' THEN 20000
			WHEN 'pro' THEN 200000
			WHEN 'team' THEN 1000000
			WHEN 'scale' THEN 1000000
			WHEN 'enterprise' THEN 10000000
			ELSE 20000
		END,
		CASE
			WHEN jsonb_typeof("subscription"."limit_overrides" -> 'includedFetchesPerMonth') = 'number'
			THEN least(
				ceil(("subscription"."limit_overrides" ->> 'includedFetchesPerMonth')::numeric),
				9007199254740991
			)
			ELSE 0
		END
	)::bigint
	FROM "org_subscriptions" AS "subscription"
	WHERE "subscription"."org_id" = "counter"."org_id" AND "counter"."included_fetches" IS NULL;
