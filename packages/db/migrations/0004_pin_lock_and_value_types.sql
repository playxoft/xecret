-- The unlock PIN, and the declared shape of a secret's value.
--
-- Two unrelated features in one migration because they ship together and both
-- are additive: every statement below either creates something new or adds a
-- column with a default. Nothing is dropped, nothing is rewritten, and every
-- row that exists before this runs is valid after it.
--
-- ── Why the PIN needs storage at all ──
-- A session lasts 30 days. That is what makes xecret usable and exactly what
-- makes an unattended laptop dangerous, so the session stays and the screen
-- locks: `sessions.pin_verified_at` records when somebody last proved they were
-- present, and `@xecret/core/auth` decides how long that lasts.
--
-- The attempt counter lives here rather than in the Worker because a Worker
-- isolate is recycled constantly — an attempt counter held in one is a counter
-- an attacker resets by waiting. Six digits is a million possibilities; the
-- lockout is what makes that enough, and a lockout that forgets is not one.

-- ── sessions ────────────────────────────────────────────────────────────────
-- Nullable, and NULL means "never unlocked". Every session that exists when
-- this runs therefore starts locked, which is the correct and conservative
-- reading: nobody has entered a PIN, because until now there were none.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pin_verified_at timestamptz;
--> statement-breakpoint

-- ── user_pins ───────────────────────────────────────────────────────────────
-- One row per user who has set a PIN. Absence is the signal that drives the
-- setup screen, so "has no PIN" needs no column of its own.
--
-- `pin_hash` holds `pbkdf2-sha256$<iterations>$<salt>$<hash>`, all base64url.
-- Self-describing so the iteration count can be raised later without a
-- migration: an existing row keeps verifying against the cost it was written
-- with, and is re-derived the next time its owner unlocks successfully.
CREATE TABLE IF NOT EXISTS user_pins (
	user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	pin_hash text NOT NULL,
	failed_attempts integer NOT NULL DEFAULT 0,
	locked_until timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ── pin_reset_tokens ────────────────────────────────────────────────────────
-- Only the SHA-256 of the emailed token, exactly as for sessions and CLI
-- tokens: a database dump yields hashes rather than working reset links.
--
-- `consumed_at` rather than a DELETE, so an already-used link is
-- distinguishable from one that never existed. Both get the same answer at the
-- API — telling them apart would confirm to a stranger that an address has an
-- account — but the difference is what makes "my reset link did not work"
-- answerable in a support conversation.
CREATE TABLE IF NOT EXISTS pin_reset_tokens (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash bytea NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	consumed_at timestamptz,
	requested_ip inet,
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pin_reset_tokens_lookup_idx
	ON pin_reset_tokens (token_hash)
	WHERE consumed_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pin_reset_tokens_user_idx
	ON pin_reset_tokens (user_id, created_at DESC);
--> statement-breakpoint

-- ── secrets.value_type ──────────────────────────────────────────────────────
-- What shape the value is expected to have. A property of the secret rather
-- than of a version: PORT is an integer in every version it will ever have, and
-- letting v4 be an integer while v5 is a URL is not a rotation, it is a
-- different secret wearing the same name.
--
-- DEFAULT 'string' backfills every existing row, and `string` accepts anything
-- — so those rows are correct under their own declared type rather than merely
-- exempt from checking.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'string';
--> statement-breakpoint

-- A CHECK rather than a PostgreSQL enum, because this list will grow. Adding a
-- value to an enum is a migration that must run before any deployment can write
-- the new value; widening a CHECK is not, and neither is rolling back to a
-- deployment that has never heard of the new type — it will simply never write
-- one. `schema.test.ts` fails if this list and `SECRET_VALUE_TYPES` diverge.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'secrets_value_type_check'
	) THEN
		ALTER TABLE secrets ADD CONSTRAINT secrets_value_type_check
			CHECK (value_type IN (
				'string','boolean','int','decimal','email','url','date','datetime',
				'json','yaml','xml','ulid','uuidv4','uuidv7'
			));
	END IF;
END
$$;
--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is not granted anything on a new
-- table automatically, so a table created here is invisible to it until this
-- runs. Migration 0002 established the role and this repeats its pattern rather
-- than editing it: an applied migration is a record of what happened, and
-- editing one to match the present is how a schema and its history drift apart.
--
-- Guarded, because a self-hoster who never ran the least-privilege migration
-- has no such role and must not be blocked by its absence.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON user_pins TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON pin_reset_tokens TO xecret_app_permissions;
	END IF;
END
$$;
