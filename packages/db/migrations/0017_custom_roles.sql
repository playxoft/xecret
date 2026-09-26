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
	-- Also the index behind every "this organisation's roles" read: its btree
	-- leads with org_id, so no separate index on org_id is needed.
	CONSTRAINT "custom_roles_org_name_unique" UNIQUE("org_id", "name"),
	-- Redundant as a uniqueness rule — `id` alone is already unique — and there
	-- only to be the target of the composite foreign key from org_members below.
	-- A foreign key has to reference a unique key, and this is the one that
	-- carries the organisation.
	CONSTRAINT "custom_roles_org_id_id_unique" UNIQUE("org_id", "id"),
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

-- ── org_members.custom_role_id ──────────────────────────────────────────────
-- `role` stays authoritative. This is a narrowing applied on top of it, never a
-- replacement, which is what keeps `canAssignRole` meaningful and what makes a
-- NULL here mean precisely what it meant before the column existed.

ALTER TABLE "org_members" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint

-- Composite, `(org_id, custom_role_id)` against `custom_roles (org_id, id)`, so
-- a member can only ever hold a role of their own organisation. Against `id`
-- alone, a member of one organisation could be pointed at another's role —
-- resolving through rules somebody else wrote, and pinning that role against
-- deletion by the organisation that owns it. MATCH SIMPLE, the default, skips
-- the check whenever `custom_role_id` is NULL, which is the built-in role and
-- has no row to point at.
--
-- ON DELETE NO ACTION, written out rather than left to the default, because
-- the choice is the point. The other two actions are wrong, and the first one
-- is dangerous:
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
--
-- NO ACTION rather than RESTRICT, though Postgres blocks exactly the same
-- deletes with either: both are the same non-deferrable check, run at the end
-- of the statement. They differ in the error. NO ACTION reports 23503
-- (foreign_key_violation) on every version; RESTRICT reports 23503 up to
-- Postgres 17 and 23001 (restrict_violation) from 18. "This role is still in
-- use" is an error the application maps, and a server upgrade should not
-- change what it looks like.
--
-- Hard-deleting the organisation still works, whichever of the two cascades
-- from `organizations` happens to fire first. Postgres runs a statement's
-- AFTER triggers in waves: every action fired by the organisation's own row —
-- both cascades — runs before any check queued by a row those actions
-- deleted. So by the time the check for a deleted role runs, the members that
-- pointed at it are gone too. That rests on both tables cascading from
-- `organizations` directly. A future path that removes members one cascade
-- later than their roles (organizations → teams → members, say) would make the
-- delete depend on trigger order, and the fix then is DEFERRABLE INITIALLY
-- DEFERRED. It is not taken now because it costs something: the in-use error
-- would arrive at COMMIT rather than at the DELETE, and until then the
-- transaction would see members pointing at a role that no longer exists.
ALTER TABLE "org_members"
	ADD CONSTRAINT "org_members_org_id_custom_role_id_custom_roles_org_id_id_fk"
	FOREIGN KEY ("org_id", "custom_role_id")
	REFERENCES "public"."custom_roles"("org_id", "id")
	ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Read by the "is this role still in use?" check that guards deletion, by the
-- foreign key's own check when a role is deleted, and by the roster view that
-- shows who holds which role. Partial, because the overwhelming majority of
-- rows carry NULL and none of them are ever the answer.
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
