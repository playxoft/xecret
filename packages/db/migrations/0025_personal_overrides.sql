-- Personal overrides (P19 §2): one value replaced on one person's machine,
-- without touching the environment everybody else reads.
--
-- ── What a row holds ──
-- A sealed box to the owner's own X25519 public key (spec §2.2 type 13), bound
-- by its AAD to this row's unique key — organisation, environment, owner, name.
-- Not under the environment's EDK, so nobody else who reads the environment can
-- open it, and no rotation has to touch it. The server stores it and serves it
-- back to its owner; it cannot read it.
--
-- ── Who it is served to ──
-- Its owner, through a person's credential (a session or a CLI login), and
-- nobody else: the route refuses a service token outright, so a personal
-- override can never reach a CI fetch. That rule lives in the route, beside the
-- pull it must never join; this table only makes the owner part of the key.
--
-- ── Read this before running it ──
-- Additive only: a new table, nothing existing touched.

CREATE TABLE "personal_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- One override per person per name per environment; also the index behind
	-- every "this person's overrides here" read, since it leads with both.
	CONSTRAINT "personal_overrides_owner_name_unique" UNIQUE ("environment_id", "user_id", "name"),
	-- The secret-name grammar, as `secrets_name_check` states it: an override
	-- becomes an environment variable in the same process a secret does.
	CONSTRAINT "personal_overrides_name_check" CHECK ("name" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);--> statement-breakpoint

ALTER TABLE "personal_overrides"
	ADD CONSTRAINT "personal_overrides_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "personal_overrides"
	ADD CONSTRAINT "personal_overrides_environment_id_environments_id_fk"
	FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "personal_overrides"
	ADD CONSTRAINT "personal_overrides_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Removing a member deletes their overrides in that organisation, and a user's
-- cascade needs an index that leads with the user.
CREATE INDEX "personal_overrides_user_idx"
	ON "personal_overrides" USING btree ("user_id", "org_id");--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- Guarded, as in 0017, for a self-hoster who never ran the least-privilege
-- migration and has no such role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON personal_overrides TO xecret_app_permissions;
	END IF;
END
$$;
