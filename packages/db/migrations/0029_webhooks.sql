-- Webhooks on secret change (P19 §5): an organisation's endpoints, and the log
-- of every delivery made to them.
--
-- ── What a delivery carries ──
-- Names, slugs, versions, counts and the actor — never a secret value, which
-- `buildWebhookPayload` cannot carry and this server could not supply for an
-- end-to-end encrypted environment anyway. Each delivery's body is stored as the
-- exact text sent, so a retry sends the same bytes under a fresh signature.
--
-- ── The signing secret ──
-- `whsec_…`, shown to its creator once and needed by this server on every
-- delivery, so it is stored *encrypted* rather than hashed: AES-256-GCM under the
-- organisation's master key (the server envelope, ADR 0002), bound by its AAD
-- to the organisation and the webhook. A database dump does not yield it; a
-- rotation of the Root KEK re-wraps the org key and leaves these readable.
--
-- ── Read this before running it ──
-- Additive only: two new tables.

CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"event_types" text[] NOT NULL,
	"secret_ciphertext" bytea NOT NULL,
	"secret_iv" bytea NOT NULL,
	-- Which version of the organisation's master key wrapped the secret.
	"secret_key_version" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	-- Why it is off: an administrator switched it off, or sustained failure did.
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	-- Failed attempts since the last success, and when that run of failures began
	-- — the two halves of `shouldDisableWebhook`.
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_events_check" CHECK (cardinality("event_types") >= 1),
	CONSTRAINT "webhooks_disabled_reason_check" CHECK (
		"disabled_reason" IS NULL OR "disabled_reason" in ('manual', 'failures')
	),
	-- Off exactly when there is a reason it is off. A disabled endpoint with no
	-- reason is one nobody can explain to the customer who owns it.
	CONSTRAINT "webhooks_enabled_reason_check" CHECK ("enabled" = ("disabled_reason" IS NULL)),
	CONSTRAINT "webhooks_failures_check" CHECK ("consecutive_failures" >= 0)
);--> statement-breakpoint

ALTER TABLE "webhooks"
	ADD CONSTRAINT "webhooks_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "webhooks"
	ADD CONSTRAINT "webhooks_created_by_users_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Every event looks up "this organisation's enabled endpoints".
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("org_id");--> statement-breakpoint

CREATE TABLE "webhook_deliveries" (
	-- Also the `webhook-id` header: stable across every retry of this delivery,
	-- which is what lets a receiver do the work once.
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	-- The exact body sent. The signature covers bytes, so a retry re-sends these.
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	-- When a sender claimed it. A claim older than a few minutes is a sender that
	-- died mid-delivery, and the sweep takes the delivery back.
	"claimed_at" timestamp with time zone,
	"last_status_code" integer,
	-- A category and a status line, never the receiver's response body: a body is
	-- arbitrary text a third party chose, and it lands in a dashboard.
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_status_check" CHECK (
		"status" in ('pending', 'delivering', 'succeeded', 'abandoned')
	),
	CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("attempts" >= 0)
);--> statement-breakpoint

ALTER TABLE "webhook_deliveries"
	ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk"
	FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "webhook_deliveries"
	ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The retry sweep: pending deliveries that are due, per organisation. The sweep
-- takes organisations in turns — each one's oldest first — so one with a
-- backlog cannot hold the others' deliveries behind it.
CREATE INDEX "webhook_deliveries_due_idx"
	ON "webhook_deliveries" USING btree ("org_id", "next_attempt_at")
	WHERE "status" = 'pending';--> statement-breakpoint

-- Claims a sender never finished, which the sweep takes back.
CREATE INDEX "webhook_deliveries_claimed_idx"
	ON "webhook_deliveries" USING btree ("claimed_at")
	WHERE "status" = 'delivering';--> statement-breakpoint

-- The dashboard's delivery log, newest first.
CREATE INDEX "webhook_deliveries_webhook_idx"
	ON "webhook_deliveries" USING btree ("webhook_id", "created_at" DESC);--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO xecret_app_permissions;
	END IF;
END
$$;
