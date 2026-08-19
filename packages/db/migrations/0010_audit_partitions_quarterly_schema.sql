-- Audit partitions: quarterly, and out of the `public` schema.
--
-- Migration 0001 partitioned `audit_logs` by month and put every child table in
-- `public`. Both decisions were right for a table that was empty; neither
-- survives contact with the retention policy.
--
-- At 3–5 years of retention, monthly partitioning means 36–60 child tables
-- sitting in `public` alongside the 15 real ones. `cli_tokens` and `env_keys`
-- end up below the fold in every table browser and every `\dt`. That is not a
-- cosmetic complaint: a schema listing an operator cannot scan is one they stop
-- reading, and this is the schema where the append-only guarantee lives.
--
-- Two changes, both while the table is small enough that they are free:
--
--   1. Partitions move to their own schema, `audit_parts`. PostgreSQL allows a
--      partition to live in a different schema from its parent, and nothing
--      about the arrangement is visible to queries — the application still
--      reads and writes `public.audit_logs` and never names a child.
--
--   2. Monthly becomes quarterly. Reads are clamped to 90 days by
--      MAX_AUDIT_RANGE_DAYS, which is one quarter, so a bounded query now opens
--      one or two partitions instead of three or four. Pruning improves. Five
--      years is 20 partitions instead of 60. The cost is retention granularity:
--      dropping history happens in three-month steps. Against a multi-year
--      policy that is not a real loss.
--
-- Existing rows are preserved. Every partition is detached, the quarterly
-- partitions are created, and the rows are re-inserted through the parent so
-- PostgreSQL routes each one to its new home.
--
-- This also closes a gap in 0002: new partitions were relying on
-- ALTER DEFAULT PRIVILEGES, which only applies to objects created by the role
-- that set it. If the maintenance job ever ran as a different role, its
-- partitions would have been unreadable by the application. The partition
-- function now issues the grants itself.
--
-- See docs/architecture/database-schema.md §8.

CREATE SCHEMA IF NOT EXISTS audit_parts;--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		EXECUTE 'GRANT USAGE ON SCHEMA audit_parts TO xecret_app_permissions';
		EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA audit_parts '
			|| 'GRANT SELECT, INSERT ON TABLES TO xecret_app_permissions';
	END IF;
END;
$$;--> statement-breakpoint

-- The `public` default privilege from 0002 existed for exactly one reason: to
-- cover monthly audit partitions as they appeared there. They no longer appear
-- there, and the rule outliving its purpose is a documented sharp edge — it
-- silently hands every future table SELECT and INSERT but not UPDATE or DELETE,
-- so a missing GRANT surfaces as a confusing runtime error on the first write
-- instead of an obvious one at migration time. Revoked, so that a new table
-- with no grant fails immediately and unambiguously.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
			|| 'REVOKE SELECT, INSERT ON TABLES FROM xecret_app_permissions';
	END IF;
END;
$$;--> statement-breakpoint

-- Creates the quarterly partition covering `target_date`, if absent, and grants
-- it append-only access. Idempotent, so the maintenance job calls it
-- unconditionally.
--
-- Replaces the monthly version from 0001. Same name and signature, so the
-- maintenance job does not care which one it is calling.
--
-- Dropped rather than CREATE OR REPLACE'd: replacing a function cannot rename
-- its parameters, and 0001 called this one `target_month` — a name that would
-- now be a lie. Nothing depends on the function, so dropping it is free.
DROP FUNCTION IF EXISTS create_audit_log_partition(date);--> statement-breakpoint

CREATE FUNCTION create_audit_log_partition(target_date date)
RETURNS void AS $$
DECLARE
	partition_name text;
	start_date date;
	end_date date;
BEGIN
	start_date := date_trunc('quarter', target_date)::date;
	end_date := (start_date + interval '3 months')::date;
	partition_name := 'audit_logs_' || to_char(start_date, 'YYYY') || 'q' || to_char(start_date, 'Q');

	IF NOT EXISTS (
		SELECT 1 FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relname = partition_name AND n.nspname = 'audit_parts'
	) THEN
		EXECUTE format(
			'CREATE TABLE audit_parts.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
			partition_name, start_date, end_date
		);

		-- Grants are issued here rather than left to ALTER DEFAULT PRIVILEGES,
		-- which is scoped to the role that set it. An audit partition the
		-- application cannot INSERT into fails every write that lands in that
		-- quarter, and it would fail on the first day of the quarter, in
		-- production, with no warning.
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
			EXECUTE format(
				'GRANT SELECT, INSERT ON audit_parts.%I TO xecret_app_permissions',
				partition_name
			);
			EXECUTE format(
				'REVOKE UPDATE, DELETE, TRUNCATE ON audit_parts.%I FROM xecret_app_permissions',
				partition_name
			);
		END IF;
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Rebuild: detach the monthly partitions, create the quarterly ones, move the
-- rows back through the parent.
DO $$
DECLARE
	child record;
	held record;
	holding text;
	n integer := 0;
	span_min timestamptz;
	span_max timestamptz;
	row_min timestamptz;
	row_max timestamptz;
	q date;
	last_q date;
BEGIN
	CREATE TEMP TABLE _audit_holding (name text) ON COMMIT DROP;

	-- Park every current partition as an ordinary table. Detaching first means
	-- the new quarterly ranges cannot collide with the old monthly ones, and
	-- that PostgreSQL does not have to scan the default partition to prove each
	-- new range is safe to add.
	FOR child IN
		SELECT n2.nspname AS ns, c.relname AS rel
		FROM pg_inherits inh
		JOIN pg_class c ON c.oid = inh.inhrelid
		JOIN pg_namespace n2 ON n2.oid = c.relnamespace
		JOIN pg_class p ON p.oid = inh.inhparent
		JOIN pg_namespace pn ON pn.oid = p.relnamespace
		WHERE p.relname = 'audit_logs' AND pn.nspname = 'public'
		ORDER BY c.relname
	LOOP
		n := n + 1;
		holding := 'zz_audit_migrate_' || n;

		EXECUTE format('ALTER TABLE public.audit_logs DETACH PARTITION %I.%I', child.ns, child.rel);

		IF child.ns <> 'public' THEN
			EXECUTE format('ALTER TABLE %I.%I SET SCHEMA public', child.ns, child.rel);
		END IF;

		EXECUTE format('ALTER TABLE public.%I RENAME TO %I', child.rel, holding);
		INSERT INTO _audit_holding VALUES (holding);
	END LOOP;

	-- The span the new partitions must cover. LEAST and GREATEST ignore NULLs,
	-- so an empty audit log simply yields the current quarter forward.
	FOR held IN SELECT name FROM _audit_holding LOOP
		EXECUTE format('SELECT min(created_at), max(created_at) FROM public.%I', held.name)
			INTO row_min, row_max;

		span_min := LEAST(span_min, row_min);
		span_max := GREATEST(span_max, row_max);
	END LOOP;

	-- Eight quarters of runway. Longer than 0001's twelve months, and the
	-- maintenance job extends it — see the note at the end of this file.
	q := date_trunc('quarter', LEAST(span_min, now()))::date;
	last_q := date_trunc('quarter', GREATEST(span_max, now() + interval '21 months'))::date;

	WHILE q <= last_q LOOP
		PERFORM create_audit_log_partition(q);
		q := (q + interval '3 months')::date;
	END LOOP;

	-- Safety net, same reasoning as 0001: an audit record must never be lost
	-- because a partition was missing. Now in audit_parts with the rest.
	IF NOT EXISTS (
		SELECT 1 FROM pg_class c
		JOIN pg_namespace ns ON ns.oid = c.relnamespace
		WHERE c.relname = 'audit_logs_default' AND ns.nspname = 'audit_parts'
	) THEN
		CREATE TABLE audit_parts.audit_logs_default PARTITION OF public.audit_logs DEFAULT;

		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
			EXECUTE 'GRANT SELECT, INSERT ON audit_parts.audit_logs_default TO xecret_app_permissions';
			EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_parts.audit_logs_default '
				|| 'FROM xecret_app_permissions';
		END IF;
	END IF;

	-- Back through the parent, so each row is routed to its quarter.
	FOR held IN SELECT name FROM _audit_holding LOOP
		EXECUTE format('INSERT INTO public.audit_logs SELECT * FROM public.%I', held.name);
		EXECUTE format('DROP TABLE public.%I', held.name);
	END LOOP;
END;
$$;--> statement-breakpoint

-- Runway ends eight quarters out. Nothing in the repository extends it yet —
-- the "monthly maintenance job" referred to by 0001 was never built. Until it
-- exists, writes past the last partition land in audit_parts.audit_logs_default,
-- and once rows for a quarter are sitting in the default partition, creating
-- the real partition for that quarter FAILS. Recovery is detach-move-reattach.
--
-- The job is one statement, run any time before the runway expires:
--
--     SELECT create_audit_log_partition((now() + interval '21 months')::date);
SELECT 1;
