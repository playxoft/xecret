-- The user vault, and the retirement of the unlock PIN.
--
-- This migration replaces one lock with another. The PIN protected a 30-day
-- session against somebody walking up to an open laptop; the vault protects the
-- same thing and, far more importantly, holds the key hierarchy under which
-- every secret becomes client-encrypted (ADR 0009, docs/security/e2ee-crypto-spec.md).
--
-- ── Read this before running it ──
-- Unlike every migration before it, this one **drops tables and a column**.
-- `user_pins`, `pin_reset_tokens` and `sessions.pin_verified_at` go, because the
-- PIN is retired rather than deprecated: ADR 0009 §4.4 records why the device
-- PIN's design did not survive review, and leaving the tables would leave a
-- second, weaker way to unlock an account that the new code no longer maintains.
--
-- The data loss is bounded and deliberate. `user_pins` holds PBKDF2 digests of
-- six-digit PINs and an attempt counter; `pin_reset_tokens` holds hashes of
-- links that expire in fifteen minutes. Neither is recoverable material, and
-- neither has any meaning under the new model. What every existing session
-- loses is its unlocked state — which is correct, because nobody has a vault
-- yet, so every session must arrive at the setup ceremony locked.
--
-- ── Order matters ──
-- The new column is added before the old one is dropped, and the new tables are
-- created before the old ones are removed, so a deployment that fails midway
-- leaves a database that the *previous* release can still serve. Rolling back
-- past this migration is a restore, not a down-migration: dropping a table has
-- no inverse, which is why this is the first migration in the project to need
-- saying so out loud.

-- ── sessions.vault_unlocked_at ──────────────────────────────────────────────
-- The rename of `pin_verified_at`, done as add-then-drop rather than
-- ALTER ... RENAME COLUMN. A rename would carry the old values across, and the
-- old values are wrong under the new model: a session that entered a PIN an
-- hour ago has *not* unlocked a vault, because there is no vault to unlock. The
-- correct starting state for every session is NULL — never unlocked — and an
-- add-then-drop is the only form that states it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vault_unlocked_at timestamptz;
--> statement-breakpoint

-- ── user_keys ───────────────────────────────────────────────────────────────
-- One row per account that has completed the vault setup ceremony. Absence
-- drives the setup flow, exactly as the absence of a `user_pins` row drove the
-- PIN setup screen.
--
-- Every column here is either public or an opaque ciphertext. There is no
-- column, and no combination of columns, from which this database can produce a
-- User Key, a private key, or a secret value — that is the whole claim of ADR
-- 0009, and it is checkable by reading this list.
--
--   enc_public_key / sign_public_key   32 raw bytes each, in the clear
--   *_private_key_enc                  ASCII of an `xk2.gcm.` blob under the User Key
--   kdf_salt                           16 random bytes; a salt is not a secret
--   kdf_params                         {alg,v,m,t,p,len} — the Argon2id cost this
--                                      user's wraps were derived at, so the cost
--                                      can be raised later without a migration
--   unlock_verifier_hash               SHA-256 of a *sibling* HKDF branch of the
--                                      wrap key. Opens nothing; it exists so the
--                                      server can gate its API, throttle, and audit
--
-- Two attempt counters, not one. A recovery code is 125 bits of uniform
-- randomness, so its limit is abuse control; the passphrase counter is a real
-- defence against a real guess. Sharing them would let a mistyped recovery code
-- spend the budget protecting the passphrase.
CREATE TABLE IF NOT EXISTS user_keys (
	user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	enc_algorithm text NOT NULL DEFAULT 'X25519',
	enc_public_key bytea NOT NULL,
	enc_private_key_enc bytea NOT NULL,
	sign_algorithm text NOT NULL DEFAULT 'Ed25519',
	sign_public_key bytea NOT NULL,
	sign_private_key_enc bytea NOT NULL,
	kdf_salt bytea NOT NULL,
	kdf_params jsonb NOT NULL,
	unlock_verifier_hash bytea NOT NULL,
	failed_attempts integer NOT NULL DEFAULT 0,
	locked_until timestamptz,
	recovery_failed_attempts integer NOT NULL DEFAULT 0,
	recovery_locked_until timestamptz,
	auto_lock_minutes integer NOT NULL DEFAULT 10,
	created_at timestamptz NOT NULL DEFAULT now(),
	rotated_at timestamptz
);
--> statement-breakpoint

-- Restates AUTO_LOCK_MINUTES_OPTIONS in @xecret/core/auth, carried over from
-- `user_pins_auto_lock_check`, so a row cannot hold an interval no settings
-- screen can display or repair.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_keys_auto_lock_check'
	) THEN
		ALTER TABLE user_keys
			ADD CONSTRAINT user_keys_auto_lock_check
			CHECK (auto_lock_minutes IN (0, 5, 10, 20, 30, 45, 60));
	END IF;
END
$$;
--> statement-breakpoint

-- ── user_passkeys ───────────────────────────────────────────────────────────
-- Passkeys enrolled for one-touch unlock through the WebAuthn PRF extension.
-- The credential's identity lives here; the key material it opens is the
-- matching `prf` row in user_key_wraps.
--
-- `credential_id` is unique across the installation rather than per user: a
-- WebAuthn credential id identifies an authenticator's credential globally, and
-- the same one under two accounts means something has gone wrong. It is also
-- interpolated into the AAD of the matching wrap, which binds that wrap to this
-- credential and to nothing else.
CREATE TABLE IF NOT EXISTS user_passkeys (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	credential_id bytea NOT NULL,
	label text NOT NULL,
	transports jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz
);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_passkeys_credential_id_unique'
	) THEN
		ALTER TABLE user_passkeys
			ADD CONSTRAINT user_passkeys_credential_id_unique UNIQUE (credential_id);
	END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS user_passkeys_user_idx
	ON user_passkeys (user_id, created_at DESC);
--> statement-breakpoint

-- ── user_key_wraps ──────────────────────────────────────────────────────────
-- Every wrap of one account's User Key: one passphrase wrap, five recovery
-- wraps, and one per enrolled passkey. All of them encrypt the *same 32 bytes*
-- under different keys, which is what makes a passphrase change one row rewrite
-- rather than a re-encryption of everything the account can read.
--
-- `kind` is text with a CHECK rather than a pgEnum, breaking this schema's usual
-- rule on purpose. The set is pinned by the crypto specification (§4.1) — the
-- kind is interpolated into every wrap's AAD — so adding a value is a spec
-- change and a new blob type, never a schema migration somebody runs on a
-- Tuesday. A CHECK says that; a pgEnum, whose advertised virtue is that values
-- append freely, would say the opposite.
CREATE TABLE IF NOT EXISTS user_key_wraps (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind text NOT NULL,
	wrap bytea NOT NULL,
	lookup_hash bytea,
	passkey_id uuid REFERENCES user_passkeys(id) ON DELETE CASCADE,
	used_at timestamptz,
	superseded_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Four constraints, stating the shape of each kind directly rather than leaving
-- it to the application. The two `=` forms are biconditional on purpose: a
-- recovery wrap without a lookup hash could never be found, and a passphrase
-- wrap carrying one would be findable by a code that does not open it — and a
-- passphrase wrap carrying a passkey_id would be cascade-deleted by unenrolling
-- a passkey, taking the account's only way in with it.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_key_wraps_kind_check'
	) THEN
		ALTER TABLE user_key_wraps
			ADD CONSTRAINT user_key_wraps_kind_check
			CHECK (kind IN ('passphrase', 'recovery', 'prf'));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_key_wraps_lookup_check'
	) THEN
		ALTER TABLE user_key_wraps
			ADD CONSTRAINT user_key_wraps_lookup_check
			CHECK ((kind = 'recovery') = (lookup_hash IS NOT NULL));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_key_wraps_passkey_check'
	) THEN
		ALTER TABLE user_key_wraps
			ADD CONSTRAINT user_key_wraps_passkey_check
			CHECK ((kind = 'prf') = (passkey_id IS NOT NULL));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'user_key_wraps_used_check'
	) THEN
		ALTER TABLE user_key_wraps
			ADD CONSTRAINT user_key_wraps_used_check
			CHECK (used_at IS NULL OR kind = 'recovery');
	END IF;
END
$$;
--> statement-breakpoint

-- **Exactly one live passphrase wrap per account** — the load-bearing
-- constraint of this table. Two live wraps would mean two passphrases open the
-- same vault, and the older one would keep working long after its owner
-- believed they had changed it: a silent, permanent downgrade with no symptom.
-- Partial, so the superseded history is unbounded while the present is unique.
CREATE UNIQUE INDEX IF NOT EXISTS user_key_wraps_passphrase_unique
	ON user_key_wraps (user_id)
	WHERE kind = 'passphrase' AND superseded_at IS NULL;
--> statement-breakpoint

-- The recovery lookup: one indexed equality on the presented code's hash. Not
-- scoped by user, because somebody redeeming a code has forgotten their
-- passphrase rather than their identity, and the row is still found by hash
-- alone. Unique so a 32-byte collision is an error rather than an ambiguity.
CREATE UNIQUE INDEX IF NOT EXISTS user_key_wraps_lookup_unique
	ON user_key_wraps (lookup_hash)
	WHERE lookup_hash IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS user_key_wraps_user_idx
	ON user_key_wraps (user_id, kind);
--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new
-- table automatically, so these tables are invisible to it until this runs.
-- Guarded, because a self-hoster who never ran the least-privilege migration
-- has no such role and must not be blocked by its absence.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON user_keys TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON user_key_wraps TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON user_passkeys TO xecret_app_permissions;
	END IF;
END
$$;
--> statement-breakpoint

-- ── retiring the PIN ────────────────────────────────────────────────────────
-- Last, and only once everything above has succeeded. `pin_reset_tokens` first
-- because nothing references it, then `user_pins`, then the session column.
--
-- No CASCADE on either DROP: both tables are referenced only by `users`, which
-- points the other way, so a plain DROP succeeds — and if some object in a
-- deployment does depend on one of them, failing loudly is the correct outcome
-- for an operator to see rather than a silent cascade through it.
DROP TABLE IF EXISTS pin_reset_tokens;
--> statement-breakpoint

DROP TABLE IF EXISTS user_pins;
--> statement-breakpoint

ALTER TABLE sessions DROP COLUMN IF EXISTS pin_verified_at;
