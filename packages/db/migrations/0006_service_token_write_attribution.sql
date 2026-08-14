-- Service-token write attribution (Phase 8).
--
-- Phase 4 shipped service tokens strictly read-only — not by policy but by
-- schema: `secrets.created_by` and `secret_versions.created_by` are NOT NULL
-- references to `users`, and a CI credential has no person behind it by
-- construction (threat T5). The two rejected repairs are recorded in
-- docs/architecture/api.md §2: attributing a CI write to whoever minted the
-- token would put a person's name on a write they did not make, and simply
-- making `created_by` nullable would weaken attribution for every write in the
-- product.
--
-- The accepted design: a second attribution column, with a CHECK requiring
-- exactly one of the two to be set. Every row is still attributed — to a
-- person or to a named token — and a row attributed to both or to neither
-- cannot exist. Existing rows all carry `created_by` and satisfy the
-- constraint as-is, so this is additive: no rewrite, no backfill.
--
-- The token reference deliberately has no ON DELETE action. Service tokens are
-- revoked, never deleted, while their organisation lives; an org deletion
-- cascades secrets and tokens away together. A SET NULL would let attribution
-- quietly vanish while the row it described survived.

ALTER TABLE secrets ALTER COLUMN created_by DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE secrets
	ADD COLUMN IF NOT EXISTS created_by_service_token_id uuid REFERENCES service_tokens(id);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'secrets_writer_check'
	) THEN
		ALTER TABLE secrets
			ADD CONSTRAINT secrets_writer_check
			CHECK (num_nonnulls(created_by, created_by_service_token_id) = 1);
	END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE secret_versions ALTER COLUMN created_by DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE secret_versions
	ADD COLUMN IF NOT EXISTS created_by_service_token_id uuid REFERENCES service_tokens(id);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'secret_versions_writer_check'
	) THEN
		ALTER TABLE secret_versions
			ADD CONSTRAINT secret_versions_writer_check
			CHECK (num_nonnulls(created_by, created_by_service_token_id) = 1);
	END IF;
END
$$;

-- No index on the new columns: "what did this token write" is answered by the
-- audit log, which records every service-token write with the token as actor.
-- An index here would serve no query the product makes.
