-- Least-privilege application role.
--
-- Threat T6 (database compromise) and the append-only audit guarantee both
-- depend on this migration. It is not optional.
--
-- Two things it enforces that application code cannot:
--   1. The application role has NO DDL rights. A SQL-injection bug or a
--      compromised connection string cannot DROP or ALTER anything.
--   2. audit_logs is append-only at the DATABASE level — INSERT and SELECT
--      only. Not by convention, not by code review: by grant. An attacker who
--      reaches the database still cannot erase the record of what they did.
--
-- Migrations run as a separate, more privileged role (MIGRATION_DATABASE_URL).
--
-- NOTE for self-hosters: on some managed providers, role creation requires the
-- account owner. If this migration fails on CREATE ROLE, create `xecret_app`
-- through your provider's console and re-run — the GRANT statements are
-- idempotent.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app') THEN
		CREATE ROLE xecret_app NOLOGIN;
	END IF;
END;
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO xecret_app;--> statement-breakpoint

-- Full DML on tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	users, sessions,
	organizations, org_members, invitations,
	projects, environments,
	org_keys, env_keys,
	secrets, secret_versions,
	access_grants,
	cli_tokens, service_tokens
TO xecret_app;--> statement-breakpoint

-- Append-only: no UPDATE, no DELETE, ever.
GRANT SELECT, INSERT ON audit_logs TO xecret_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM xecret_app;--> statement-breakpoint

-- Partitions inherit grants at creation time only, so apply to existing ones
-- and set the default for future partitions created by the maintenance job.
DO $$
DECLARE
	part record;
BEGIN
	FOR part IN
		SELECT c.relname
		FROM pg_class c
		JOIN pg_inherits i ON i.inhrelid = c.oid
		JOIN pg_class p ON p.oid = i.inhparent
		WHERE p.relname = 'audit_logs'
	LOOP
		EXECUTE format('GRANT SELECT, INSERT ON public.%I TO xecret_app', part.relname);
		EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM xecret_app', part.relname);
	END LOOP;
END;
$$;--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO xecret_app;--> statement-breakpoint

-- Sequences are only used by any future serial columns; none today, but the
-- grant keeps the role usable without needing DDL rights later.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xecret_app;
