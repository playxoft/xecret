-- Organisation SSO, review round 2 (WS-5): the WorkOS environment this
-- database belongs to, the AuthKit session behind each xecret session, when a
-- session's sign-in was a fresh authentication, and the link check made VALID.
--
-- ── workos_home ─────────────────────────────────────────────────────────────
-- One row: the WorkOS client id of the environment whose organisation ids this
-- database's `organizations.workos_org_id` may hold. A WorkOS organisation id
-- means something only in the environment that created it, and local
-- development runs against WorkOS Staging while sharing the production
-- database. Round 1 recorded the environment beside each link and refused to
-- act on a foreign one — but nothing stopped one being written: an "enable"
-- clicked in local development linked a production organisation, permanently
-- (the link is never re-pointed), to a Staging organisation no production
-- sign-in can come through.
--
-- So the link's only writer (`setOrgWorkosOrgId`, behind `POST
-- /api/orgs/{slug}/sso`) — and every route that switches an SSO policy on —
-- refuses unless this deployment's `WORKOS_CLIENT_ID` is the one recorded
-- here. With no row, it refuses too, naming the operator step.
--
-- Seeded with the Playxoft production environment's client id, because this
-- migration runs first against the Playxoft production database, and that is
-- the environment whose links it holds. **A self-hosted deployment records its
-- own** (docs/self-hosting.md, "The WorkOS environment"):
--   UPDATE workos_home SET client_id = '<your WORKOS_CLIENT_ID>';
-- Until it does, turning SSO on refuses with a message that says so — nothing
-- else in a self-hosted deployment reads this table.
--
-- `id` is a boolean that can only be true: a primary key with one possible
-- value is a table with at most one row, without a trigger.
CREATE TABLE "workos_home" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"client_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workos_home_single_row_check" CHECK ("id"),
	CONSTRAINT "workos_home_client_id_check" CHECK ("client_id" ~ '^client_[0-9A-Za-z]+$')
);
--> statement-breakpoint
INSERT INTO "workos_home" ("id", "client_id") VALUES (true, 'client_01M36CECX3Z66Q2FYY2FN8WG73');--> statement-breakpoint

-- ── organizations_workos_link_client_check, made VALID ──────────────────────
-- 0022 added the CHECK `NOT VALID`, so that a pre-release link without a
-- client id would not stop the migration. That was the wrong trade: Postgres
-- checks a NOT VALID constraint on every UPDATE of a row, so such a row could
-- not be renamed, soft-deleted, have its plan set, or even have its SSO
-- policies switched off — each one a 500.
--
-- Before 0022, only production code could have written a link (nothing in a
-- release before WS-5 sets `workos_org_id`, and a build that does records the
-- client id with it), so a linked row with no client id is a production link:
-- it is backfilled with the production client id, as `workos_home` is seeded,
-- and then the constraint is validated. The deploy notes make the pre-check a
-- hard gate — on a database where that query returns anything, an operator
-- decides first (docs/operations/workos-environments.md):
--   SELECT id, slug FROM organizations
--    WHERE workos_org_id IS NOT NULL AND workos_client_id IS NULL;
UPDATE "organizations"
	SET "workos_client_id" = 'client_01M36CECX3Z66Q2FYY2FN8WG73'
	WHERE "workos_org_id" IS NOT NULL AND "workos_client_id" IS NULL;--> statement-breakpoint
ALTER TABLE "organizations" VALIDATE CONSTRAINT "organizations_workos_link_client_check";--> statement-breakpoint

-- ── sessions.workos_session_id ──────────────────────────────────────────────
-- The AuthKit session the sign-in that issued this xecret session came from:
-- the `sid` claim of the access token in the code exchange's own response, the
-- one value of that token kept. Sign-out used to revoke only the xecret
-- session, which left AuthKit's own session alive on its hosted domain — so
-- nearly every returning person's next sign-in was answered without asking,
-- and held back as a reused session for them to confirm, which taught people
-- to click "Continue". Sign-out now answers with WorkOS's logout URL for this
-- id, and the browser follows it, ending the AuthKit session too.
--
-- NULL for every session issued before this migration, and for a sign-in whose
-- token carried none: those sign out exactly as before. Not a credential — a
-- WorkOS session id names a session, it does not authenticate as it — and held
-- to WorkOS's shape so a value that is not one never reaches a URL.
ALTER TABLE "sessions" ADD COLUMN "workos_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_workos_session_id_check"
	CHECK ("workos_session_id" IS NULL OR "workos_session_id" ~ '^session_[0-9A-Za-z]{1,64}$');--> statement-breakpoint

-- ── sessions.fresh_auth_at ──────────────────────────────────────────────────
-- When the person actively authenticated for the re-authentication that
-- issued this session — WorkOS's `auth_time`, during the flow — by any method
-- that re-proves who they are, an emailed code included. NULL for every other
-- session. What the SSO setup portal's step-up reads (it used to borrow the
-- vault reset's first lock, which refuses an emailed code by design — so an
-- owner who signs in by emailed code could never open the portal). The vault
-- reset's stricter record in `reauthentications` is unchanged.
--
-- The authentication's own time, not the moment the session row was written:
-- a sign-in held back for confirmation is issued up to five minutes after the
-- person authenticated, and a ten-minute window must not quietly become
-- fifteen.
ALTER TABLE "sessions" ADD COLUMN "fresh_auth_at" timestamp with time zone;--> statement-breakpoint

-- ── Operational rule: this migration first, then the code ──
-- As 0021 and 0022: every `select()` on `sessions` names the new columns from
-- the build that declares them, and the SSO settings read `workos_home`, so
-- that build fails against a database without them. Applying this first is
-- harmless: older code never reads the new columns or table, and the validated
-- CHECK is one every row older code writes already satisfies.
--
-- ── grants ──────────────────────────────────────────────────────────────────
-- The new columns inherit table-level privileges (0002). `workos_home` is read
-- by the application and never written by it — recording the environment is an
-- operator's act — so the application role may only SELECT it.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT ON workos_home TO xecret_app_permissions;
	END IF;
END
$$;
