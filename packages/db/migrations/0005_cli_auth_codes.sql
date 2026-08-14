-- Pending CLI authorizations, for the `xecret login` handshake (Phase 6).
--
-- The flow: the CLI opens a browser to the consent screen carrying a PKCE
-- challenge; an already-signed-in person approves the named device; a row is
-- written here and its one-time code handed to the CLI's loopback listener;
-- the CLI exchanges code + PKCE verifier for a `cli_tokens` row. This table is
-- the bridge between the two halves and nothing else — a row here is not a
-- credential, and reading one out of a database dump mints nothing: the code
-- is stored hashed, and the exchange additionally demands the verifier, which
-- never left the CLI process.
--
-- Additive only: one new table, nothing dropped, nothing rewritten.

CREATE TABLE IF NOT EXISTS cli_auth_codes (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	device_name text NOT NULL,
	-- SHA-256 of the one-time code, exactly as every other token in the product.
	token_hash bytea NOT NULL UNIQUE,
	-- base64url SHA-256 of the CLI's PKCE verifier (RFC 7636, S256 only).
	code_challenge text NOT NULL,
	-- The approving browser's address — the consent side, not the CLI side.
	requested_ip inet,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	-- Consumption rather than deletion, so "was this approval ever exchanged?"
	-- stays answerable until the cleanup job runs. Same design as
	-- pin_reset_tokens, for the same incident-review reason.
	consumed_at timestamptz
);
--> statement-breakpoint

-- Hot path: the exchange resolves the presented code through this.
CREATE INDEX IF NOT EXISTS cli_auth_codes_lookup_idx
	ON cli_auth_codes (token_hash) WHERE consumed_at IS NULL;
--> statement-breakpoint

-- Lets a new approval invalidate the user's outstanding codes in one write,
-- and powers the cleanup of expired rows.
CREATE INDEX IF NOT EXISTS cli_auth_codes_user_idx
	ON cli_auth_codes (user_id, created_at DESC);
--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is not granted anything on a new
-- table automatically — same pattern as migration 0004, guarded for
-- self-hosters who never created the least-privilege role.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON cli_auth_codes TO xecret_app_permissions;
	END IF;
END
$$;
