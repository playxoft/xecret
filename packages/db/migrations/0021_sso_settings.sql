-- Organisation SSO settings (WS-5): the just-in-time opt-in, and the rule that
-- neither SSO flag can be on for an organisation that never enabled SSO.
--
-- ── organizations.jit_join_enabled ──────────────────────────────────────────
-- Whether somebody signing in through this organisation's single sign-on may be
-- made a member of it on the spot, as a `viewer`, while seats last.
--
-- Off by default, and off on every existing row. Before this column the sign-in
-- callback joined anybody arriving through an organisation's SSO connection,
-- unconditionally, the moment that organisation had a `workos_org_id` — and
-- nothing could set one yet, so it never happened. WS-5 is what makes
-- `workos_org_id` settable, so the opt-in has to arrive in the same change: an
-- organisation linked to WorkOS must not start admitting people because its
-- administrator connected an identity provider. Admitting them is a decision of
-- its own, taken by an owner or admin, and audited (`org.sso.jit_toggled`).
--
-- The callback reads it under the organisation's row lock, in the same
-- transaction that checks the seat limit and writes the membership
-- (`joinOrganizationJustInTime`), so an administrator switching it off is never
-- raced past by a sign-in already in flight.
ALTER TABLE "organizations"
	ADD COLUMN "jit_join_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ── Neither flag without the link ───────────────────────────────────────────
-- `sso_required` says a member may only sign in through this organisation's
-- own SSO connection, and `jit_join_enabled` says that connection may admit new
-- members. Both are about a connection, and an organisation with no
-- `workos_org_id` has none. `sso_required` on such an organisation would refuse
-- every non-owner member's every sign-in with no way to satisfy it.
--
-- The settings route refuses both before they reach here; this is what holds
-- for a psql session, a script, or the next caller that forgot. Satisfiable on
-- every existing row: both flags are false everywhere (nothing could set
-- `sso_required` before this change). And it can never be broken afterwards by
-- the link going away, because nothing can clear `workos_org_id`
-- (`setOrgWorkosOrgId` sets it once and never re-points it).
ALTER TABLE "organizations"
	ADD CONSTRAINT "organizations_sso_flags_need_link_check"
	CHECK (("sso_required" = false AND "jit_join_enabled" = false) OR "workos_org_id" IS NOT NULL);--> statement-breakpoint

-- ── Operational rule: this migration first, then the code ──
-- Drizzle's `select()` names every column the schema declares, so from the
-- build that declares `jit_join_enabled` on, every `select()` on
-- `organizations` — the per-request tenancy lookup among them — names it, and
-- fails with "column does not exist" against a database without it. Applying
-- this first is harmless: the column is invisible to older code, and the CHECK
-- holds on every row older code can write (it never sets either flag).
--
-- ── grants ──────────────────────────────────────────────────────────────────
-- No new table, so no new grant: the application role already holds DML on
-- `organizations` from migration 0002, and a new column inherits table-level
-- privileges. Recorded rather than omitted, as 0018 does, so the next migration
-- to add a table does not take this file's silence as the convention.
SELECT 1;
