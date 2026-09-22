-- Custom roles: an organisation narrowing a built-in role for itself.
--
-- ── The property this table is built around ──
-- A custom role can only **subtract**. Every row names a `base_role`, and the
-- authorization engine resolves a member as `base AND custom`, never as the
-- custom row alone (`effectiveCapabilities` in @xecret/core/authz). There is
-- therefore no row here — malformed, hand-edited, or written by somebody who
-- reached the database — that grants a capability the base role does not
-- already hold. Escalation through this table is unreachable, rather than
-- prevented by validation that could be bypassed.
--
-- That is the same one-way shape as `limit_overrides` on `org_subscriptions`,
-- chosen for the same reason: a mechanism with a single direction has no bugs
-- in the other one.
--
-- ── Read this before running it ──
-- Additive only. `org_members.custom_role_id` is nullable and every existing
-- row keeps NULL, which means exactly what it meant before this migration:
-- the built-in role, unchanged. Nothing is backfilled because there is nothing
-- to backfill.
--
-- ── Order ──
-- The table, then the column that references it, then the grants.

CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_role" "org_role" NOT NULL,
	"allowed_actions" text[] DEFAULT '{}' NOT NULL,
	"ceiling_non_production" "access_level",
	"ceiling_production" "access_level",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_roles_org_name_unique" UNIQUE("org_id", "name"),
	-- Both halves of a ceiling or neither. A half-set ceiling would apply in one
	-- kind of environment and not the other, which is a rule nobody can state
	-- and therefore a rule nobody can audit.
	CONSTRAINT "custom_roles_ceiling_check" CHECK (
		("custom_roles"."ceiling_non_production" IS NULL)
		= ("custom_roles"."ceiling_production" IS NULL)
	)
);--> statement-breakpoint

ALTER TABLE "custom_roles"
	ADD CONSTRAINT "custom_roles_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "custom_roles"
	ADD CONSTRAINT "custom_roles_created_by_users_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
	ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "custom_roles_org_idx"
	ON "custom_roles" USING btree ("org_id", "name");--> statement-breakpoint

-- ── org_members.custom_role_id ──────────────────────────────────────────────
-- `role` stays authoritative. This is a narrowing applied on top of it, never a
-- replacement, which is what keeps `canAssignRole` meaningful and what makes a
-- NULL here mean precisely what it meant before the column existed.

ALTER TABLE "org_members" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint

-- ON DELETE RESTRICT, and it is the only RESTRICT in this schema. Both
-- alternatives are worse, and the first one is dangerous:
--
--   * SET NULL silently **widens** every member holding the role the moment it
--     is deleted. A "Deployer" who could not reach production becomes a plain
--     developer who can — with no act that looks like a permission change, and
--     nothing in the audit log that reads as one. Deleting a role is the kind of
--     tidying somebody does on a Friday.
--   * CASCADE would delete the members.
--
-- So a role that is in use cannot be dropped until its members are moved off
-- it, and the widening becomes something an administrator did deliberately and
-- one member at a time, each of which is already an audited `member.role_changed`.
ALTER TABLE "org_members"
	ADD CONSTRAINT "org_members_custom_role_id_custom_roles_id_fk"
	FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Read by the "is this role still in use?" check that guards deletion, and by
-- the roster view that shows who holds which role. Partial, because the
-- overwhelming majority of rows carry NULL and none of them are ever the answer.
CREATE INDEX "org_members_custom_role_idx"
	ON "org_members" USING btree ("custom_role_id")
	WHERE "custom_role_id" IS NOT NULL;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new
-- table automatically. Guarded, because a self-hoster who never ran the
-- least-privilege migration has no such role and must not be blocked by its
-- absence.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON custom_roles TO xecret_app_permissions;
	END IF;
END
$$;
