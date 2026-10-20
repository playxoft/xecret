-- Policies (P19 §6, §8, §9, §7): the organisation's token and secret policies,
-- and two switches on each environment.
--
-- ── org_policies ────────────────────────────────────────────────────────────
-- One row per organisation that has ever set a policy; no row means every
-- default (`DEFAULT_TOKEN_POLICY`, `DEFAULT_SECRET_POLICY` — both of which ask
-- nothing). A table of its own rather than more columns on `organizations`,
-- because the tenancy lookup that runs on every request selects every column
-- `organizations` declares, and none of these is needed there.
--
-- The plan gates *setting* a policy, never the enforcement of one already set:
-- an organisation that downgrades keeps every control it switched on (P19 §6).
-- That rule is the application's; nothing here knows about plans.
CREATE TABLE "org_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"token_require_ip_allowlist" boolean DEFAULT false NOT NULL,
	"token_max_lifetime_days" integer,
	-- `SecretPolicy` from @xecret/core/policy, validated before it is stored.
	-- NULL is the shipped default ruleset, switched off.
	"secret_policy" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_policies_token_lifetime_check" CHECK (
		"token_max_lifetime_days" IS NULL OR "token_max_lifetime_days" BETWEEN 1 AND 3650
	),
	CONSTRAINT "org_policies_secret_policy_object_check" CHECK (
		"secret_policy" IS NULL OR jsonb_typeof("secret_policy") = 'object'
	)
);--> statement-breakpoint

ALTER TABLE "org_policies"
	ADD CONSTRAINT "org_policies_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "org_policies"
	ADD CONSTRAINT "org_policies_updated_by_users_id_fk"
	FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── environments.plaintext_export_disabled (P19 §9) ─────────────────────────
-- Whether `xecret pull` / `export` — the paths that write every value to a file
-- or a terminal — are refused for this environment. `run` is not affected: it
-- injects into a process and writes nothing down.
--
-- Honest about its reach, as the documentation is: on an end-to-end encrypted
-- environment the values travel to the CLI as ciphertext either way, and the
-- refusal is the CLI's — a guardrail against the habit of exporting production,
-- not a boundary against somebody who can already run `xecret run -- env`.
ALTER TABLE "environments"
	ADD COLUMN "plaintext_export_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ── environments.read_alerts (P19 §7) ───────────────────────────────────────
-- Whether a read from an unseen address or device emails the organisation's
-- owners and admins. NULL is the default — on for production, off elsewhere —
-- so marking an environment production switches its alerts on without anybody
-- remembering to.
ALTER TABLE "environments" ADD COLUMN "read_alerts" boolean;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON org_policies TO xecret_app_permissions;
	END IF;
END
$$;
