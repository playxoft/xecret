-- Secret references and environment inheritance (P19 §1).
--
-- ── What the server stores, and what it cannot ──
-- Values are end-to-end encrypted (ADR 0009), so a reference written inside a
-- value — `postgres://${DB_USER}@${shared.DB_HOST}/app` — is ciphertext here.
-- The server cannot read it, so it cannot resolve it, and it cannot check it
-- for a cycle. What makes both possible is that every writer of a template
-- *declares* its references beside the ciphertext, in plaintext: names and
-- slugs, which are plaintext already (ADR 0009, trade-off 1). The server checks
-- the declared graph for cycles, depth and dangling targets before storing
-- anything, works out from it which ciphertexts a pull must carry, and audits
-- the referenced reads. The clients resolve the values, and refuse a template
-- whose text and declaration disagree.
--
-- ── Read this before running it ──
-- Additive only. Every existing environment keeps a NULL parent, every existing
-- version a NULL declaration, and no existing secret is a `template` — so every
-- view, every pull and every value means exactly what it meant before. The
-- operational rule of 0021 applies: this migration first, then the code that
-- names these columns, because Drizzle's `select()` names every declared column.

-- ── environments.parent_environment_id ─────────────────────────────────────
-- The environment this one inherits from: its view is its own secrets laid over
-- the parent's view, child values winning (`@xecret/core/references`).
ALTER TABLE "environments" ADD COLUMN "parent_environment_id" uuid;--> statement-breakpoint

-- The target of the composite foreign key below. Redundant as a uniqueness rule
-- — `id` is the primary key — and present only because a foreign key has to
-- reference a unique key, and this is the one that carries the project.
ALTER TABLE "environments"
	ADD CONSTRAINT "environments_project_id_id_unique" UNIQUE ("project_id", "id");--> statement-breakpoint

-- Composite, so a parent is always in the **same project**. Against `id` alone,
-- an environment could be pointed at another project's — or another
-- organisation's — and every pull would then try to carry ciphertext across a
-- tenancy boundary the rest of the schema never lets anything cross. MATCH
-- SIMPLE skips the check for a NULL parent, which is the common case.
--
-- NO ACTION, for the reason 0017 gives: a parent cannot be hard-deleted out
-- from under a child that still names it. (Soft deletion is refused by the
-- application, which names the children.) A project's hard delete still works:
-- both rows cascade from `projects` in one statement, and the check runs after.
ALTER TABLE "environments"
	ADD CONSTRAINT "environments_parent_same_project_fk"
	FOREIGN KEY ("project_id", "parent_environment_id")
	REFERENCES "public"."environments"("project_id", "id")
	ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The one loop a row can express on its own. Longer loops, and the depth limit,
-- are refused by the application before the write (`checkContexts`), because a
-- CHECK cannot follow a chain.
ALTER TABLE "environments"
	ADD CONSTRAINT "environments_parent_not_self_check"
	CHECK ("parent_environment_id" IS NULL OR "parent_environment_id" <> "id");--> statement-breakpoint

-- "Who inherits from this one?" — asked before an environment is deleted and
-- whenever a change to it has to be re-checked in every view it reaches.
CREATE INDEX "environments_parent_idx"
	ON "environments" USING btree ("parent_environment_id")
	WHERE "parent_environment_id" IS NOT NULL;--> statement-breakpoint

-- ── secret_versions.declared_references ────────────────────────────────────
-- What a template version's writer declared it refers to: a JSON array of
-- `{ project?, environment?, name, environmentId }`, where the slugs are the
-- text as written and `environmentId` is what they resolved to at write time
-- (NULL for an unqualified `${KEY}`, which means "the environment being read").
--
-- On the version, not the secret: a template's references are a property of
-- one value, and the history of what a secret pointed at should read like the
-- history of its value. NULL for every non-template version.
--
-- Not named `references`, which is a reserved word every hand-written query
-- would have to quote.
ALTER TABLE "secret_versions" ADD COLUMN "declared_references" jsonb;--> statement-breakpoint

ALTER TABLE "secret_versions"
	ADD CONSTRAINT "secret_versions_declared_references_array_check"
	CHECK ("declared_references" IS NULL OR jsonb_typeof("declared_references") = 'array');--> statement-breakpoint

-- "Does anything point at this environment?" — asked before an environment or a
-- referenced secret is removed. `jsonb_path_ops` because the only question is
-- containment (`@> '[{"environmentId": "…"}]'`).
CREATE INDEX "secret_versions_declared_references_idx"
	ON "secret_versions" USING gin ("declared_references" jsonb_path_ops)
	WHERE "declared_references" IS NOT NULL;--> statement-breakpoint

-- ── secrets.value_type gains `template` ─────────────────────────────────────
-- The opt-in. A secret whose declared type is `template` has its `${…}` read as
-- references; a secret of any other type is literal text, for ever. Widening a
-- CHECK is the reason value types are a CHECK and not an enum (see 0004).
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_value_type_check";--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_value_type_check"
	CHECK ("value_type" in ('string','boolean','int','decimal','email','url','date','datetime','json','yaml','xml','ulid','uuidv4','uuidv7','template'));--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- No new table: the application role already holds DML on `environments`,
-- `secrets` and `secret_versions`, and new columns inherit table privileges.
SELECT 1;
