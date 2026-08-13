-- Renames the application's group role to say what it is.
--
-- `xecret_app` and the login role beside it (commonly `xecret_web`) were
-- indistinguishable by name. Nothing in either told you that one is a set of
-- permissions that cannot log in, and the other is a login that holds them —
-- so the obvious guess, putting `xecret_app` in a connection string, fails with
-- an authentication error that explains nothing.
--
-- After this migration:
--
--   xecret_app_permissions   NOLOGIN. The job description: what the application
--                            may do. Cannot connect. Created by migration 0002.
--
--   xecret_app_login         LOGIN. The employee: how the application connects.
--                            Has the password. Created by the operator.
--
-- and the grant that joins them reads as an English sentence:
--
--     GRANT xecret_app_permissions TO xecret_app_login;
--
-- ALTER ROLE ... RENAME preserves every grant and every membership, so this is
-- a pure renaming — no privilege is added, removed, or re-derived.
--
-- Migration 0002 is left alone despite now naming a role that no longer exists
-- by that name. Migrations are a record of what happened, and editing an
-- applied one to match the present is how a schema and its history drift apart.

DO $$
BEGIN
	-- Guarded on both sides so this is a no-op on a database that has already
	-- been renamed, and on one where 0002 has not run.
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app')
		AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions')
	THEN
		ALTER ROLE xecret_app RENAME TO xecret_app_permissions;
	END IF;
END;
$$;--> statement-breakpoint

-- The login role is created by the operator, not by a migration — it carries a
-- password, and a password does not belong in a file that is committed. So it
-- is renamed only if it exists under the name the setup guide used to suggest.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_web')
		AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_login')
	THEN
		ALTER ROLE xecret_web RENAME TO xecret_app_login;
	END IF;
END;
$$;--> statement-breakpoint

-- The password survives the rename, on any modern PostgreSQL.
--
-- Worth stating because the opposite is a well-known footgun: MD5-encrypted
-- passwords use the role name as their salt, so renaming a role *clears* an
-- MD5 password. SCRAM-SHA-256 does not — its salt is random and stored beside
-- the verifier — and SCRAM has been the default since PostgreSQL 14.
--
-- So on PG 14+ only the username in DATABASE_URL changes. If a deployment has
-- `password_encryption = md5` set explicitly, the password is gone and the
-- operator must run:
--
--     ALTER ROLE xecret_app_login PASSWORD '<a new one>';
--
-- Either way nothing is lost that cannot be replaced. A database password is
-- resettable in one statement, unlike the Root KEK.
SELECT 1;
