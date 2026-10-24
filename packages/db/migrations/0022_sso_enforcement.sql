-- Organisation SSO, enforced (WS-5, review round 1): how each credential
-- signed in, which WorkOS environment an organisation's link belongs to, who
-- was removed from an organisation, and the sign-in confirmations already
-- spent.
--
-- ── sessions / cli_auth_codes / cli_tokens: sign_in_method, sso_workos_org_id ──
-- `sso_required` used to be checked once, at sign-in, and never again. A
-- session issued before the flag went on — thirty days of it — and a CLI token
-- minted from one (whose `expires_at` may be NULL: for ever) kept the
-- organisation's resources in reach without its identity provider ever having
-- been asked. So the credential now says how it came to exist, and the
-- per-request organisation resolution (`resolveOrg`) reads it:
--
--   sign_in_method     the audit log's closed set (`SignInMethod` in
--                      @xecret/core/audit). NULL for every row written before
--                      this migration — "not known", which enforcement reads as
--                      "not single sign-on", the safe direction.
--   sso_workos_org_id  the WorkOS organisation whose single sign-on issued this
--                      credential, or NULL. Set only for `sso` (checked below).
--                      An organisation that requires SSO admits, among its
--                      non-owner members, only credentials whose value here is
--                      its own `workos_org_id`.
--
-- A CLI token inherits both from the browser session that approved it: the
-- approval (`cli_auth_codes`) records them, and the exchange copies them onto
-- the token. A device approved from a password session is a password
-- credential, however it is later presented.
ALTER TABLE "sessions" ADD COLUMN "sign_in_method" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sso_workos_org_id" text;--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_sign_in_method_check"
	CHECK ("sign_in_method" IS NULL OR "sign_in_method" IN ('password', 'oauth', 'sso', 'magic_auth', 'passkey', 'other'));--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_sso_org_needs_sso_check"
	CHECK ("sso_workos_org_id" IS NULL OR "sign_in_method" = 'sso');--> statement-breakpoint

ALTER TABLE "cli_auth_codes" ADD COLUMN "sign_in_method" text;--> statement-breakpoint
ALTER TABLE "cli_auth_codes" ADD COLUMN "sso_workos_org_id" text;--> statement-breakpoint
ALTER TABLE "cli_auth_codes"
	ADD CONSTRAINT "cli_auth_codes_sign_in_method_check"
	CHECK ("sign_in_method" IS NULL OR "sign_in_method" IN ('password', 'oauth', 'sso', 'magic_auth', 'passkey', 'other'));--> statement-breakpoint
ALTER TABLE "cli_auth_codes"
	ADD CONSTRAINT "cli_auth_codes_sso_org_needs_sso_check"
	CHECK ("sso_workos_org_id" IS NULL OR "sign_in_method" = 'sso');--> statement-breakpoint

ALTER TABLE "cli_tokens" ADD COLUMN "sign_in_method" text;--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD COLUMN "sso_workos_org_id" text;--> statement-breakpoint
ALTER TABLE "cli_tokens"
	ADD CONSTRAINT "cli_tokens_sign_in_method_check"
	CHECK ("sign_in_method" IS NULL OR "sign_in_method" IN ('password', 'oauth', 'sso', 'magic_auth', 'passkey', 'other'));--> statement-breakpoint
ALTER TABLE "cli_tokens"
	ADD CONSTRAINT "cli_tokens_sso_org_needs_sso_check"
	CHECK ("sso_workos_org_id" IS NULL OR "sign_in_method" = 'sso');--> statement-breakpoint

-- ── organizations.workos_client_id ──────────────────────────────────────────
-- The WorkOS environment (by its client id) the `workos_org_id` link was made
-- in. A WorkOS organisation id means something only inside the environment that
-- created it, and local development runs against WorkOS Staging while sharing
-- the production database: an "enable" clicked there would otherwise link a
-- production organisation, permanently (the link is never re-pointed), to a
-- Staging organisation no production sign-in can ever come through. The
-- settings routes refuse to act on a link whose client id is not this
-- deployment's `WORKOS_CLIENT_ID`, and an enable never adopts one.
--
-- The CHECK is NOT VALID: enforced on every write from now on, not asserted of
-- rows already there. Nothing could set `workos_org_id` before WS-5, so there
-- should be none — but a link made by a pre-release build of WS-5 (0021 applied
-- by hand) would carry no client id and must not stop this migration. Such a
-- row reads as "a different environment" everywhere until an operator records
-- the client id it was made with (see the deploy notes):
--   SELECT id, slug FROM organizations
--    WHERE workos_org_id IS NOT NULL AND workos_client_id IS NULL;
ALTER TABLE "organizations" ADD COLUMN "workos_client_id" text;--> statement-breakpoint
ALTER TABLE "organizations"
	ADD CONSTRAINT "organizations_workos_link_client_check"
	CHECK ("workos_org_id" IS NULL OR "workos_client_id" IS NOT NULL) NOT VALID;--> statement-breakpoint

-- ── org_member_removals ─────────────────────────────────────────────────────
-- Somebody removed from an organisation. Removal deletes the `org_members` row
-- (its access grants go with it, by cascade), which used to leave nothing
-- behind — so a person removed here but still in the organisation's identity
-- provider was silently re-admitted, as a viewer, by their next single sign-on
-- (just-in-time membership). This row is what the just-in-time join checks
-- first; it answers `removed`, writes nothing, and the sign-in audits
-- `member.jit_denied`. Only an invitation brings them back, and accepting one
-- deletes this row.
--
-- A table of its own rather than a status on `org_members`: a "removed" member
-- row would have to be filtered out of every membership read, seat count and
-- owner count in the product — each one a place to forget it — whereas this is
-- read by exactly one query and written by exactly one function.
-- `removed_by` is NULL for a removal nobody else made (an account deleting
-- itself); it survives the remover's account (SET NULL).
CREATE TABLE "org_member_removals" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_removals_pkey" PRIMARY KEY ("org_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── sign_in_confirmations ───────────────────────────────────────────────────
-- The ledger that makes a sign-in confirmation single-use. When a sign-in comes
-- back from WorkOS through an organisation the flow did not ask for — the
-- planted-session login CSRF — or from a session WorkOS reused without asking,
-- the callback issues no session: it parks the outcome in a sealed, five-minute
-- cookie and asks the person "Continue as …?". The cookie carries a random
-- nonce; continuing (or cancelling) inserts its SHA-256 here, and a second use
-- of the same cookie collides with the primary key and is refused. Rows are
-- useless after `expires_at` (the cookie is refused by then anyway) and may be
-- deleted by a scheduled job.
CREATE TABLE "sign_in_confirmations" (
	"nonce_hash" bytea PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A SHA-256 digest and nothing else, like every other single-use value.
	CONSTRAINT "sign_in_confirmations_nonce_hash_length_check" CHECK (octet_length("nonce_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "sign_in_confirmations" ADD CONSTRAINT "sign_in_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── Operational rule: this migration first, then the code ──
-- As 0021: every `select()` on `sessions`, `cli_tokens`, `cli_auth_codes` and
-- `organizations` names the new columns from the build that declares them, so
-- that build fails against a database without them. Applying this first is
-- harmless — older code never reads or writes the new columns or tables, and
-- the CHECKs hold for every row it writes (NULLs throughout; it never links an
-- organisation).
--
-- ── grants ──────────────────────────────────────────────────────────────────
-- The new columns inherit table-level privileges (0002). The two new tables are
-- granted nothing automatically (0010 revoked the default privileges), so they
-- are granted here, guarded as 0019 does for a self-hoster without the role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON org_member_removals TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON sign_in_confirmations TO xecret_app_permissions;
	END IF;
END
$$;
