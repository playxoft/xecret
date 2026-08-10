-- Audit log partitioning.
--
-- Drizzle cannot express PARTITION BY RANGE, so audit_logs is recreated here as
-- a partitioned table. This is safe: migration 0000 created it moments ago and
-- it is necessarily empty.
--
-- Why partition at all: secret.read is the highest-volume event in the system
-- (every `xecret run`, every CI build). Partitioning keeps queries fast and makes
-- retention a DROP TABLE rather than a mass DELETE against a hot table.
--
-- See docs/architecture/database-schema.md §8.

DROP TABLE IF EXISTS "audit_logs";--> statement-breakpoint

CREATE TABLE "audit_logs" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint

CREATE INDEX "audit_logs_org_time_idx" ON "audit_logs" ("org_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" ("org_id","actor_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" ("org_id","action","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_logs_environment_idx" ON "audit_logs" ("environment_id","created_at" DESC);--> statement-breakpoint

-- Creates the monthly partition covering `target_month`, if absent.
-- Idempotent, so the monthly maintenance job can call it unconditionally.
CREATE OR REPLACE FUNCTION create_audit_log_partition(target_month date)
RETURNS void AS $$
DECLARE
	partition_name text;
	start_date date;
	end_date date;
BEGIN
	start_date := date_trunc('month', target_month)::date;
	end_date := (start_date + interval '1 month')::date;
	partition_name := 'audit_logs_' || to_char(start_date, 'YYYY_MM');

	IF NOT EXISTS (
		SELECT 1 FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relname = partition_name AND n.nspname = 'public'
	) THEN
		EXECUTE format(
			'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
			partition_name, start_date, end_date
		);
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Pre-create 12 months so a missed maintenance run cannot break audit writes.
DO $$
DECLARE
	i integer;
BEGIN
	FOR i IN 0..11 LOOP
		PERFORM create_audit_log_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
	END LOOP;
END;
$$;--> statement-breakpoint

-- Safety net: an audit record must never be lost because a partition was
-- missing. An audit write failing would either drop the record or fail the
-- request — both unacceptable for a security product.
--
-- OPERATIONAL CAVEAT: if rows land here for a month that is later added as a
-- real partition, CREATE TABLE ... PARTITION OF will fail. The monthly job
-- keeps 12 months ahead so this should not happen. Recovery procedure, should
-- it ever be needed, is documented in docs/deployment/ (Phase 16).
CREATE TABLE IF NOT EXISTS "audit_logs_default" PARTITION OF "audit_logs" DEFAULT;
