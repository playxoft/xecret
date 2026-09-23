-- WorkOS identity columns, alongside the Firebase ones.
--
-- Nothing is dropped here, and that is the whole design of this migration.
-- `firebase_uid` stays — it becomes nullable, keeps its unique constraint and
-- keeps its index — for two reasons, and the second is the important one:
--
--   1. It is the join key the user backfill matches on. The WorkOS import
--      produces a `firebase_uid → workos_user_id` mapping, and a second pass
--      writes `workos_user_id` onto rows found by `firebase_uid`. Drop the
--      column and there is nothing to match against.
--
--   2. **It is the rollback.** Until a deliberate decommission migration — a
--      separate change, well after production cutover — the old provider stays
--      a working answer to "who is this person". A cutover that goes wrong is
--      then recoverable instead of terminal, which for the login path of a
--      secrets manager is not a luxury.
--
-- ── Read this before running it ──
-- Additive and reversible-by-inaction. Every existing row keeps its
-- `firebase_uid` and gains a NULL `workos_user_id`, which is exactly what it
-- means: this person has not signed in through WorkOS yet. Deploying this
-- without deploying the code that uses it changes nothing for anybody.
--
-- ── Order ──
-- The nullable relaxation first, because the check constraint added afterwards
-- has to be satisfiable while every row still carries only a Firebase id.

-- ── users.firebase_uid becomes nullable ─────────────────────────────────────
-- A user who signs up after the swap never had a Firebase account. Forcing a
-- synthetic value would put a lie into the one column the rollback depends on
-- being true, so the column learns to be absent instead.
--
-- The UNIQUE constraint is deliberately kept. Postgres treats NULLs as distinct
-- under a unique constraint, so any number of post-swap users coexist — while
-- two rows claiming the *same* Firebase account stay impossible, which is what
-- keeps the backfill unambiguous in the one place ambiguity would be fatal.
ALTER TABLE "users" ALTER COLUMN "firebase_uid" DROP NOT NULL;--> statement-breakpoint

-- ── users.workos_user_id ────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "workos_user_id" text;--> statement-breakpoint

ALTER TABLE "users"
	ADD CONSTRAINT "users_workos_user_id_unique" UNIQUE("workos_user_id");--> statement-breakpoint

-- Mirrors `users_firebase_uid_idx` exactly, partial predicate included. This is
-- read on every single login; an index without the predicate would have the hot
-- path of the entire product fetch soft-deleted rows in order to discard them.
CREATE INDEX "users_workos_user_id_idx"
	ON "users" USING btree ("workos_user_id")
	WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- A row must remain reachable by *some* provider.
--
-- Without this, a bug in the linking pass could write a user nobody can ever
-- authenticate as: a row that exists, owns organisations, holds key grants, and
-- has no way back in. There is no repair for that from inside the application,
-- because every repair path starts with logging in.
--
-- Satisfiable at the moment it is added because every existing row still has a
-- `firebase_uid`, which is why the NOT NULL was dropped first.
ALTER TABLE "users"
	ADD CONSTRAINT "users_identity_present_check"
	CHECK ("firebase_uid" IS NOT NULL OR "workos_user_id" IS NOT NULL);--> statement-breakpoint

-- ── organizations.workos_org_id ─────────────────────────────────────────────
-- Lazily populated: only an organisation that actually enables SSO gets a
-- WorkOS Organization. Almost every row in this table is a personal org
-- auto-provisioned at first login, and minting a provider tenant for each of
-- those would fill WorkOS with organisations that exist for nobody.
ALTER TABLE "organizations" ADD COLUMN "workos_org_id" text;--> statement-breakpoint

ALTER TABLE "organizations"
	ADD CONSTRAINT "organizations_workos_org_id_unique" UNIQUE("workos_org_id");--> statement-breakpoint

-- ── organizations.sso_required ──────────────────────────────────────────────
-- A member of this organisation may only sign in through its own SSO
-- connection. Ships together with the enforcement in the callback, because the
-- flag without the check is worse than having neither: it tells an
-- administrator a bypass is closed while it is open.
--
-- Enforcement always exempts at least one owner. A misconfigured identity
-- provider would otherwise lock an organisation out of its own account with no
-- self-service way back, and "contact support" is not a recovery story for a
-- product whose whole job is holding credentials.
ALTER TABLE "organizations"
	ADD COLUMN "sso_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- No new tables, so no new grants: the application role already holds DML on
-- `users` and `organizations` from migration 0002, and column privileges are
-- not granted separately in PostgreSQL unless they were restricted that way.
-- Recorded rather than omitted, so the next migration to add a table does not
-- take this file's silence as the convention.
SELECT 1;
