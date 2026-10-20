-- New-location read alerts (P19 §7): which addresses and devices have read each
-- environment, so the first read from a new one can be told to the people who
-- should know.
--
-- ── What a sighting is ──
-- One (environment, principal, address) triple, first seen and last seen. The
-- principal is the device for a CLI login and a CI token — each login and each
-- token is its own row in `cli_tokens` / `service_tokens` — and the person for a
-- browser session, so a new laptop is a new sighting and a new browser tab is
-- not. IPv6 addresses are recorded as their /64, the unit a single host's
-- privacy addresses rotate within; an IPv4 address is recorded whole.
--
-- Written after the response, never on its path: a read is never slower, and
-- never refused, for having been recorded.
--
-- ── Digest throttling ──
-- `read_alert_digests` holds when each organisation was last mailed. A new
-- sighting mails immediately only if the organisation has not been mailed in
-- the last hour; otherwise it waits, un-notified, for the scheduled digest. A CI
-- fleet on rotating addresses therefore produces one email an hour, listing
-- them, and never one per runner.
--
-- ── Read this before running it ──
-- Additive only: two new tables.

CREATE TABLE "environment_read_sightings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" uuid NOT NULL,
	-- How the principal read in the alert — an email, a token name. Denormalised
	-- for the same reason as the audit log's actor label.
	"principal_label" text,
	"ip_address" inet NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- When an alert covering this sighting was sent, or NULL while one is owed.
	"notified_at" timestamp with time zone,
	CONSTRAINT "environment_read_sightings_unique"
		UNIQUE ("environment_id", "principal_kind", "principal_id", "ip_address"),
	CONSTRAINT "environment_read_sightings_kind_check" CHECK (
		"principal_kind" in ('user', 'cli_token', 'service_token')
	)
);--> statement-breakpoint

ALTER TABLE "environment_read_sightings"
	ADD CONSTRAINT "environment_read_sightings_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "environment_read_sightings"
	ADD CONSTRAINT "environment_read_sightings_environment_id_environments_id_fk"
	FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The digest sweep: owed alerts, by organisation.
CREATE INDEX "environment_read_sightings_owed_idx"
	ON "environment_read_sightings" USING btree ("org_id", "first_seen_at")
	WHERE "notified_at" IS NULL;--> statement-breakpoint

CREATE TABLE "read_alert_digests" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "read_alert_digests"
	ADD CONSTRAINT "read_alert_digests_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON environment_read_sightings TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON read_alert_digests TO xecret_app_permissions;
	END IF;
END
$$;
