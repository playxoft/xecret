-- Audit partitions: quarterly, and out of the `public` schema.
--
-- Migration 0001 partitioned `audit_logs` by month and put every child table in
-- `public`. Both decisions were right for a table that was empty; neither
-- survives contact with the retention policy.
--
-- At 3–5 years of retention, monthly partitioning means 36–60 child tables
-- sitting in `public` alongside the 18 real ones. `cli_tokens` and `env_keys`
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
-- "Small enough that they are free" is the premise the whole rebuild rests on,
-- so it is checked rather than assumed — see the row-count guard below.
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

-- USAGE only. There is deliberately no ALTER DEFAULT PRIVILEGES here: it is the
-- same role-scoped mechanism this migration revokes in `public` twenty lines
-- down, and `create_audit_log_partition()` grants each partition explicitly, so
-- a default rule would be both redundant and a standing offer of SELECT+INSERT
-- to any non-partition table a future migration happens to put in this schema.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		EXECUTE 'GRANT USAGE ON SCHEMA audit_parts TO xecret_app_permissions';
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
--
-- A default-privilege rule belongs to the role that created it, and a bare
-- REVOKE only touches the current role's own rules. If 0002 ran as `postgres`
-- and this migration runs as a dedicated migration role — which is exactly what
-- docs/operations/database-setup.md tells operators to do — a bare REVOKE would
-- match nothing and report success, leaving the sharp edge in place while the
-- documentation claims it is closed. So the grantor is looked up and named.
DO $$
DECLARE
	grantor_name text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		RETURN;
	END IF;

	FOR grantor_name IN
		SELECT DISTINCT pg_get_userbyid(d.defaclrole)
		FROM pg_default_acl d
		JOIN pg_namespace n ON n.oid = d.defaclnamespace
		CROSS JOIN LATERAL aclexplode(d.defaclacl) a
		WHERE n.nspname = 'public'
			AND d.defaclobjtype = 'r'
			AND a.grantee = 'xecret_app_permissions'::regrole
	LOOP
		BEGIN
			EXECUTE format(
				'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
					|| 'REVOKE SELECT, INSERT ON TABLES FROM xecret_app_permissions',
				grantor_name
			);
		EXCEPTION WHEN insufficient_privilege THEN
			-- Naming a role in ALTER DEFAULT PRIVILEGES requires membership in it.
			-- Rather than fail the migration over a rule that is inert until some
			-- future migration adds a table, say precisely what is left to do.
			RAISE WARNING
				'could not revoke the public default-privilege rule owned by %. '
				'Run this as that role before adding any new table: '
				'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
				'REVOKE SELECT, INSERT ON TABLES FROM xecret_app_permissions;',
				grantor_name;
		END;
	END LOOP;
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
	is_attached boolean;
BEGIN
	start_date := date_trunc('quarter', target_date)::date;
	end_date := (start_date + interval '3 months')::date;
	partition_name := 'audit_logs_' || to_char(start_date, 'YYYY') || 'q' || to_char(start_date, 'Q');

	-- Attachment, not mere existence. The recovery procedure documented at the
	-- foot of this file detaches a partition, and an interrupted recovery leaves
	-- the name occupied by a table that is no longer part of `audit_logs`. A
	-- name check would report that quarter covered while the parent has no
	-- partition for it at all.
	SELECT EXISTS (
		SELECT 1
		FROM pg_inherits inh
		JOIN pg_class c ON c.oid = inh.inhrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_class p ON p.oid = inh.inhparent
		JOIN pg_namespace pn ON pn.oid = p.relnamespace
		WHERE c.relname = partition_name AND n.nspname = 'audit_parts'
			AND p.relname = 'audit_logs' AND pn.nspname = 'public'
	) INTO is_attached;

	IF NOT is_attached THEN
		IF EXISTS (
			SELECT 1 FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relname = partition_name AND n.nspname = 'audit_parts'
		) THEN
			RAISE EXCEPTION
				'audit_parts.% exists but is not attached to public.audit_logs. '
				'Re-attach it, or drop it if its rows are already in the parent, '
				'then retry.',
				partition_name;
		END IF;

		-- Bounds are written as explicit UTC timestamps. `created_at` is
		-- `timestamptz`, so a bare date literal is resolved using the session's
		-- TimeZone: a partition added by hand from a psql session set to, say,
		-- Asia/Kolkata would start 18:30 UTC of the previous day, and would
		-- either collide with its neighbour or leave a silent five-and-a-half
		-- hour gap whose rows land in the default partition — which then blocks
		-- that quarter's real partition permanently.
		EXECUTE format(
			'CREATE TABLE audit_parts.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
			partition_name,
			to_char(start_date, 'YYYY-MM-DD') || ' 00:00:00+00',
			to_char(end_date, 'YYYY-MM-DD') || ' 00:00:00+00'
		);
	END IF;

	-- Outside the branch above, so that calling this function repairs a
	-- partition that exists without grants as well as creating a missing one.
	-- That is not hypothetical: a partition created while the role did not yet
	-- exist (0002 can fail on CREATE ROLE on managed providers, and the operator
	-- creates the role afterwards) or created by hand during recovery has no
	-- grants, and an audit partition the application cannot INSERT into fails
	-- every write that lands in that quarter, on the first day of the quarter,
	-- in production, with no warning. Grants are issued here rather than left to
	-- ALTER DEFAULT PRIVILEGES, which is scoped to the role that set it.
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
	row_count bigint;
	total_rows bigint := 0;
	span_floor timestamptz;
	span_ceiling timestamptz;
	q date;
	last_q date;
	is_attached boolean;
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

	-- One pass per parked table: the span the new partitions must cover, and the
	-- number of rows this migration is about to rewrite. LEAST and GREATEST
	-- ignore NULLs, so an empty audit log simply yields the current quarter
	-- forward.
	FOR held IN SELECT name FROM _audit_holding LOOP
		EXECUTE format('SELECT count(*), min(created_at), max(created_at) FROM public.%I', held.name)
			INTO row_count, row_min, row_max;

		total_rows := total_rows + row_count;
		span_min := LEAST(span_min, row_min);
		span_max := GREATEST(span_max, row_max);
	END LOOP;

	-- The premise, enforced. Everything here runs inside the single transaction
	-- drizzle wraps around the pending migrations, holding ACCESS EXCLUSIVE on
	-- `audit_logs` from the first DETACH to the final DROP: every audit write
	-- blocks for the duration, and a blocked audit write fails the request that
	-- produced it. Re-inserting through the parent also rebuilds the primary key
	-- and four indexes, and needs room for a second copy of the data. On a small
	-- table that is a moment; `secret.read` fires on every `xecret run` and every
	-- CI build, so it does not stay a small table forever. Refuse rather than
	-- take an unbounded outage on a table nobody measured first.
	IF total_rows > 1000000 THEN
		RAISE EXCEPTION
			'audit_logs holds % rows; this migration rewrites the whole table '
			'under ACCESS EXCLUSIVE and is only safe while that table is small. '
			'Move the data with a partition-by-partition ATTACH instead, during '
			'a maintenance window, then mark this migration applied.',
			total_rows;
	END IF;

	-- Bound the rebuild. The loop below walks one quarter at a time, so without
	-- a floor a single outlying `created_at` — a restored dump, a clock that
	-- skewed — turns it into hundreds of CREATE TABLEs inside this transaction.
	-- Outliers are refused rather than absorbed: quietly leaving them for the
	-- default partition poisons the quarter they belong to, and creating that
	-- quarter's real partition afterwards then fails permanently.
	span_floor := date_trunc('quarter', now() - interval '5 years');
	span_ceiling := date_trunc('quarter', now() + interval '21 months');

	IF span_min IS NOT NULL AND span_min < span_floor THEN
		RAISE EXCEPTION
			'audit_logs holds a row dated %, before the five-year floor this '
			'migration covers. Archive or correct it, then retry.',
			span_min;
	END IF;

	IF span_max IS NOT NULL AND span_max >= span_ceiling + interval '3 months' THEN
		RAISE EXCEPTION
			'audit_logs holds a row dated %, beyond the runway this migration '
			'creates. Archive or correct it, then retry.',
			span_max;
	END IF;

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
	-- Attachment again, not existence — a detached leftover named
	-- `audit_logs_default` would otherwise suppress the net entirely, and the
	-- first write outside a real range would fail the request that produced it.
	SELECT EXISTS (
		SELECT 1
		FROM pg_inherits inh
		JOIN pg_class c ON c.oid = inh.inhrelid
		JOIN pg_namespace ns ON ns.oid = c.relnamespace
		JOIN pg_class p ON p.oid = inh.inhparent
		JOIN pg_namespace pn ON pn.oid = p.relnamespace
		WHERE c.relname = 'audit_logs_default' AND ns.nspname = 'audit_parts'
			AND p.relname = 'audit_logs' AND pn.nspname = 'public'
	) INTO is_attached;

	IF NOT is_attached THEN
		IF EXISTS (
			SELECT 1 FROM pg_class c
			JOIN pg_namespace ns ON ns.oid = c.relnamespace
			WHERE c.relname = 'audit_logs_default' AND ns.nspname = 'audit_parts'
		) THEN
			RAISE EXCEPTION
				'audit_parts.audit_logs_default exists but is not attached to '
				'public.audit_logs. Re-attach it, or drop it if its rows are '
				'already in the parent, then retry.';
		END IF;

		CREATE TABLE audit_parts.audit_logs_default PARTITION OF public.audit_logs DEFAULT;
	END IF;

	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		EXECUTE 'GRANT SELECT, INSERT ON audit_parts.audit_logs_default TO xecret_app_permissions';
		EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_parts.audit_logs_default '
			|| 'FROM xecret_app_permissions';
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
-- The job fills every quarter from the current one to the end of the runway,
-- rather than only the last one. A single `create_audit_log_partition((now() +
-- interval '21 months')::date)` is correct only if it runs exactly quarterly:
-- run it eight months apart and it creates the far quarter while leaving the
-- ones in between uncovered, which is the unrecoverable case above. Filling the
-- whole range is idempotent, so cadence stops mattering — any interval shorter
-- than the runway is safe:
--
--     SELECT create_audit_log_partition(d::date)
--     FROM generate_series(
--         date_trunc('quarter', now()),
--         date_trunc('quarter', now() + interval '21 months'),
--         interval '3 months'
--     ) AS d;
SELECT 1;
