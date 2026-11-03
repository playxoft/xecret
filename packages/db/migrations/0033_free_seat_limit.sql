-- The Free plan seats three: `organizations.seat_limit`'s default, and the Free
-- organisations still sitting on the old one, brought down to the plan.
--
-- ── Read this before running it ──
-- One column default changed and one backfill. No column, constraint or table.
-- The order against the build that ships with it does not matter: that build
-- writes 3 wherever it writes a Free ceiling (`FREE_SEAT_LIMIT`, now read from
-- the plan), and the one before it wrote 5 only when a paid subscription ended
-- — onto a row that carries its Dodo ids, which this backfill leaves alone
-- whichever ran first.
--
-- ── organizations.seat_limit ──
-- What an invitation, an acceptance and the just-in-time join are refused
-- against. It has defaulted to 5 since the initial schema, beside a Free plan
-- that publishes 3 (`FREE_LIMITS.seats`, packages/core/src/entitlements/
-- plans.ts) — and the looser of the two was the one that applied. The default
-- is now the plan's.
--
-- ── The backfill, and what it leaves alone ──
-- An organisation moves from 5 to 3 only when every one of these holds:
--   - it is live, and `seat_limit` is exactly 5: the old default, which nobody
--     chose. A ceiling support raised is never lowered here;
--   - its plan is Free (`org_subscriptions.plan`; an organisation with no row
--     reads as Free, as entitlement resolution reads it);
--   - it carries nothing of a Dodo subscription — no subscription, customer,
--     product, mode, applied event or scheduled change (`carriesProviderIds`,
--     packages/db/src/repositories/billing.ts). Stricter than "not billed by
--     Dodo" (`billedByDodo`, which on Free means a paid checkout waiting for
--     its activation): a Free row that ended a subscription keeps its ids, and
--     the 5 on it was written when it ended rather than left by a default;
--     `operatorManaged` is never true of a Free row at all;
--   - support has granted it no limit override of any kind
--     (`org_subscriptions.limit_overrides` absent or empty);
--   - and three seats hold it: seated members, whatever their status
--     (suspension frees no seat), plus open, unexpired invitations come to
--     three or fewer. One already seating or promising more keeps 5, because
--     lowering it would put the organisation over its own limit.
--
-- Every Free organisation left at 5 for one of the last three reasons is
-- reported: one WARNING per organisation, naming it and saying why.
-- `npm run db:migrate` forwards warnings and drops notices (src/migrate.ts), so
-- they reach the operator's terminal. Once its members are sorted out, one can
-- be moved by hand:
--   UPDATE organizations SET seat_limit = 3, updated_at = now() WHERE id = '<id>';
--
-- Nobody is removed and no invitation is withdrawn by any of this. A seat
-- limit refuses the next invitation; it never touches a member already seated.
--
-- ── Concurrency ──
-- Each candidate is locked first (`FOR UPDATE`, the lock every seat decision in
-- the application takes before it counts), and its seats are counted after, so
-- an invitation issued or accepted while this runs is either counted here or
-- waits for it.

ALTER TABLE "organizations" ALTER COLUMN "seat_limit" SET DEFAULT 3;--> statement-breakpoint

DO $$
DECLARE
	candidate record;
	seated integer;
	promised integer;
BEGIN
	FOR candidate IN
		SELECT
			o.id,
			o.slug::text AS slug,
			(
				s.dodo_subscription_id IS NOT NULL
				OR s.dodo_customer_id IS NOT NULL
				OR s.dodo_product_id IS NOT NULL
				OR s.dodo_mode IS NOT NULL
				OR s.dodo_event_at IS NOT NULL
				OR s.dodo_event_id IS NOT NULL
				OR s.dodo_scheduled_change_at IS NOT NULL
			) AS carries_provider_ids,
			(
				s.limit_overrides IS NOT NULL
				AND s.limit_overrides NOT IN ('{}'::jsonb, 'null'::jsonb)
			) AS overridden
		FROM organizations o
		LEFT JOIN org_subscriptions s ON s.org_id = o.id
		WHERE o.seat_limit = 5
			AND o.deleted_at IS NULL
			AND coalesce(s.plan::text, 'free') = 'free'
		ORDER BY o.id
		FOR UPDATE OF o
	LOOP
		IF candidate.carries_provider_ids THEN
			RAISE WARNING 'migration 0033: organisation % (%) keeps seat_limit 5: it carries a Dodo subscription''s ids',
				candidate.id, candidate.slug;
			CONTINUE;
		END IF;

		IF candidate.overridden THEN
			RAISE WARNING 'migration 0033: organisation % (%) keeps seat_limit 5: support has overridden its limits',
				candidate.id, candidate.slug;
			CONTINUE;
		END IF;

		SELECT count(*) INTO seated
			FROM org_members
			WHERE org_id = candidate.id AND seat_assigned;
		SELECT count(*) INTO promised
			FROM invitations
			WHERE org_id = candidate.id
				AND accepted_at IS NULL
				AND revoked_at IS NULL
				AND expires_at > now();

		IF seated + promised > 3 THEN
			RAISE WARNING 'migration 0033: organisation % (%) keeps seat_limit 5: % seated member(s) and % open invitation(s) need more than the Free plan''s 3 seats',
				candidate.id, candidate.slug, seated, promised;
			CONTINUE;
		END IF;

		UPDATE organizations SET seat_limit = 3, updated_at = now() WHERE id = candidate.id;
	END LOOP;
END
$$;
