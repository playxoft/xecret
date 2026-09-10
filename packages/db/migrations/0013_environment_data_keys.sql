-- Environment data keys, signed grants, and the dual-mode secret columns.
--
-- Migration 0011 gave every *person* a key hierarchy the server cannot open.
-- This one does the same for every *environment*: an Env Data Key the server has
-- never held the bytes of, an Env HMAC Key beside it, and one sealed grant per
-- principal that may use them (ADR 0009, docs/security/e2ee-crypto-spec.md §§5–6).
--
-- ── Read this before running it ──
-- Unlike 0011, this migration **drops nothing and loses nothing**. Every existing
-- environment keeps its `env_keys` row and keeps working exactly as before; the
-- new columns are additive, and the one column that could not be added as a
-- nullable afterthought — `environments.encryption_mode` — is backfilled to the
-- behaviour those rows already have. Rolling back past this migration is still a
-- restore rather than a down-migration, because the four new tables have no
-- inverse, but nothing served by the previous release stops working if it is
-- applied and not deployed.
--
-- ── The one asymmetry worth understanding ──
-- `environments.encryption_mode` is added with a DEFAULT of 'server' and then has
-- its default changed to 'e2ee'. That is not a mistake and not a two-step for its
-- own sake: the DEFAULT clause is what backfills the existing rows, and every
-- existing row is a server-envelope environment. Changing the default afterwards
-- is what makes every environment created from this deployment onward end-to-end
-- encrypted. One statement could not say both things.
--
-- ── Order ──
-- Tables before the columns that reference them, and the `secret_versions`
-- constraints last of all, because two of them are only satisfiable once the new
-- columns exist and the existing rows have been shown to satisfy them.

-- ── env_data_keys ───────────────────────────────────────────────────────────
-- The Environment Data Key, by version. **This table holds no key material.**
-- It is an identity and a version: which environment, which generation, who
-- created it, when. The bytes live only inside `env_key_grants`, sealed to a
-- public key whose private half this database has never seen — which is the
-- entire difference between this table and `env_keys` beside it, and the
-- property every future column here must be checked against.
--
-- A rotation inserts a new row and retires the old one. Retired rows stay
-- forever: historical `secret_versions` still reference them, and deleting one
-- would orphan every value written under it.
CREATE TABLE IF NOT EXISTS env_data_keys (
	id uuid PRIMARY KEY,
	environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
	version integer NOT NULL,
	status text NOT NULL DEFAULT 'active',
	created_by uuid NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'env_data_keys_status_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE env_data_keys
			ADD CONSTRAINT env_data_keys_status_check
			CHECK (status IN ('active', 'retired'));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'env_data_keys_version_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE env_data_keys
			ADD CONSTRAINT env_data_keys_version_check CHECK (version >= 1);
	END IF;

	-- A version number names one key, forever. Grants bind `edkVersion` into
	-- their AAD (spec §4.2), so two rows sharing one would be two keys that a
	-- single grant claims to open.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'env_data_keys_environment_version_unique'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE env_data_keys
			ADD CONSTRAINT env_data_keys_environment_version_unique UNIQUE (environment_id, version);
	END IF;
END
$$;
--> statement-breakpoint

-- **Exactly one active EDK per environment** — the load-bearing constraint of
-- this table, and partial for the same reason `user_key_wraps_passphrase_unique`
-- is: the retired history is unbounded while the present is unique. Two active
-- rows would be two answers to "which key does the next write use", and a client
-- picking the older one would encrypt under a key a revoked principal still
-- holds, silently undoing the rotation that retired it.
CREATE UNIQUE INDEX IF NOT EXISTS env_data_keys_active_unique
	ON env_data_keys (environment_id)
	WHERE status = 'active';
--> statement-breakpoint

-- ── env_hmac_keys ───────────────────────────────────────────────────────────
-- One row per environment, never versioned, holding — again — no key material.
--
-- The EHK exists for exactly one reason: `valueHmac` must survive an EDK
-- rotation (spec §9). If the HMAC key rotated with the data key, the first write
-- to every secret after a rotation would be recorded as a change when nothing
-- changed, and "when did this credential last actually change?" would become
-- unanswerable precisely for the environments that had just had a security
-- incident. `environment_id` is UNIQUE because two HMAC keys is two clients
-- disagreeing about whether a value changed.
CREATE TABLE IF NOT EXISTS env_hmac_keys (
	id uuid PRIMARY KEY,
	environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
	created_by uuid NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'env_hmac_keys_environment_unique'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE env_hmac_keys
			ADD CONSTRAINT env_hmac_keys_environment_unique UNIQUE (environment_id);
	END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS env_hmac_keys_environment_idx ON env_hmac_keys (environment_id);
--> statement-breakpoint

-- ── env_key_grants ──────────────────────────────────────────────────────────
-- One principal's copy of an environment's two keys, each sealed to that
-- principal's X25519 public key, and an Ed25519 signature over both.
--
-- `edk_sealed` and `ehk_sealed` are separate columns rather than one sealed pair
-- because the EHK is re-sealed *unchanged* across a rotation while the EDK is
-- replaced: one column would mean re-sealing a key that did not change, on every
-- rotation, for nothing.
--
-- `signature` and `signed_by_user_id` are NOT NULL. Verification is deferred past
-- v1 — it needs a trust root for signer keys — but the columns are not, because
-- turning verification on later has to be a client update rather than a data
-- migration over grants that never carried a signature. A nullable signature
-- would guarantee exactly the migration it was meant to avoid, and there are no
-- legacy rows to accommodate: this table is created with the constraint.
CREATE TABLE IF NOT EXISTS env_key_grants (
	id uuid PRIMARY KEY,
	env_data_key_id uuid NOT NULL REFERENCES env_data_keys(id) ON DELETE CASCADE,
	member_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
	service_token_id uuid REFERENCES service_tokens(id) ON DELETE CASCADE,
	invitation_id uuid REFERENCES invitations(id) ON DELETE CASCADE,
	edk_sealed bytea NOT NULL,
	ehk_sealed bytea NOT NULL,
	signature bytea NOT NULL,
	signed_by_user_id uuid NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Exactly one principal, in the same `num_nonnulls` shape `secrets_writer_check`
-- already uses — this schema has one way of saying "exactly one of these". A
-- discriminator column beside three nullable ids would let the two disagree, and
-- the discriminator is what goes into the AAD, so a disagreement there produces a
-- grant the principal it names cannot open.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'env_key_grants_principal_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE env_key_grants
			ADD CONSTRAINT env_key_grants_principal_check
			CHECK (num_nonnulls(member_user_id, service_token_id, invitation_id) = 1);
	END IF;
END
$$;
--> statement-breakpoint

-- One grant per principal per key version. Three partial unique indexes rather
-- than one composite, because PostgreSQL treats NULLs as distinct: a plain
-- UNIQUE over all four columns would admit two identical member grants, since the
-- two NULL columns make the rows "different". Inside a partial index the column
-- is never NULL, so uniqueness means what it says.
CREATE UNIQUE INDEX IF NOT EXISTS env_key_grants_member_unique
	ON env_key_grants (env_data_key_id, member_user_id)
	WHERE member_user_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS env_key_grants_token_unique
	ON env_key_grants (env_data_key_id, service_token_id)
	WHERE service_token_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS env_key_grants_invitation_unique
	ON env_key_grants (env_data_key_id, invitation_id)
	WHERE invitation_id IS NOT NULL;
--> statement-breakpoint

-- "Which environments can this person open?" — read on every dashboard
-- navigation, and by the vault-reset cascade, which must find every grant sealed
-- to a public key it is about to destroy.
CREATE INDEX IF NOT EXISTS env_key_grants_member_idx
	ON env_key_grants (member_user_id)
	WHERE member_user_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS env_key_grants_key_idx ON env_key_grants (env_data_key_id);
--> statement-breakpoint

-- ── pending_key_grants ──────────────────────────────────────────────────────
-- The queue of grants an admin could not seal.
--
-- Access is decided by people who may not hold the key. An owner can grant a
-- developer access to `production` without ever having opened `production`, and
-- if they hold no grant on it their browser has no EDK to seal. Refusing the
-- access change would make authorization depend on who happens to hold which
-- key; granting access with no key would leave a member who can list every
-- secret name and decrypt none of them, with nothing anywhere saying why. So the
-- access change lands and a row here records the debt, which the next unlocked
-- member holding that EDK fulfils.
--
-- Every column is an id or a timestamp. A pending row is a request, not authority
-- and not key material: it grants nothing.
CREATE TABLE IF NOT EXISTS pending_key_grants (
	id uuid PRIMARY KEY,
	environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
	target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	requested_by uuid NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One debt per person per environment: widening a grant twice before anybody
-- fulfils it owes the same single key, and a second row would show the same
-- person twice in the "1 pending key share" banner.
CREATE UNIQUE INDEX IF NOT EXISTS pending_key_grants_unique
	ON pending_key_grants (environment_id, target_user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pending_key_grants_environment_idx
	ON pending_key_grants (environment_id);
--> statement-breakpoint

-- ── environments.encryption_mode ────────────────────────────────────────────
-- Which hierarchy an environment's values are encrypted under. A migration
-- mechanism, not a product option: nothing in the API lets a caller choose.
--
-- Added with DEFAULT 'server', which is what backfills every existing row —
-- every one of them *is* a server-envelope environment, so this states a fact
-- rather than making an assumption. The default is then changed to 'e2ee', which
-- is what makes every environment created from this deployment onward end-to-end
-- encrypted. Two statements because one clause cannot say both things.
ALTER TABLE environments
	ADD COLUMN IF NOT EXISTS encryption_mode text NOT NULL DEFAULT 'server';
--> statement-breakpoint

ALTER TABLE environments ALTER COLUMN encryption_mode SET DEFAULT 'e2ee';
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'environments_encryption_mode_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE environments
			ADD CONSTRAINT environments_encryption_mode_check
			CHECK (encryption_mode IN ('server', 'e2ee'));
	END IF;
END
$$;
--> statement-breakpoint

-- ── secrets.enc_note ────────────────────────────────────────────────────────
-- `xk2.gcm.` blob (spec §2.2, type 10): the note, encrypted under the EDK. The
-- plaintext `note` column stays, and stays in use, for `server`-mode rows.
--
-- No CHECK pairs the two. The rule that governs which one is written depends on
-- `environments.encryption_mode`, which is a join away and unreachable from a row
-- constraint; the application decides, in `secrets-service.ts`.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS enc_note bytea;
--> statement-breakpoint

-- ── secret_versions: the dual-mode columns ──────────────────────────────────
-- `env_key_id` becomes nullable and `env_data_key_id` appears beside it. Exactly
-- one is set, which is what says whether the Worker can read the row at all.
ALTER TABLE secret_versions
	ADD COLUMN IF NOT EXISTS env_data_key_id uuid REFERENCES env_data_keys(id) ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE secret_versions ADD COLUMN IF NOT EXISTS client_algorithm text;
--> statement-breakpoint

ALTER TABLE secret_versions ALTER COLUMN env_key_id DROP NOT NULL;
--> statement-breakpoint

-- The IV moves *into* the blob for e2ee rows (spec §2.1), so the column is NULL
-- for them. Dropping NOT NULL here does not weaken the original invariant — the
-- CHECK below restores it for exactly the rows it ever applied to.
ALTER TABLE secret_versions ALTER COLUMN iv DROP NOT NULL;
--> statement-breakpoint

-- The three constraints that make the dual-mode period safe. Added after the
-- columns and after the backfill, because every existing row already satisfies
-- all three — each one has an `env_key_id`, an `iv`, and no `client_algorithm` —
-- so these are validated against real data rather than merely declared.
--
-- `secret_versions_key_check` is the important one. A row naming both keys claims
-- two different sets of bytes decrypt it; a row naming neither is ciphertext
-- nothing can ever open and would additionally read as an e2ee row to any query
-- testing `env_key_id IS NULL`. Both are silent, permanent data loss.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'secret_versions_key_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE secret_versions
			ADD CONSTRAINT secret_versions_key_check
			CHECK (num_nonnulls(env_key_id, env_data_key_id) = 1);
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'secret_versions_server_iv_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE secret_versions
			ADD CONSTRAINT secret_versions_server_iv_check
			CHECK ((env_key_id IS NOT NULL) = (iv IS NOT NULL));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'secret_versions_client_algorithm_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE secret_versions
			ADD CONSTRAINT secret_versions_client_algorithm_check
			CHECK ((env_data_key_id IS NOT NULL) = (client_algorithm IS NOT NULL));
	END IF;
END
$$;
--> statement-breakpoint

-- ── service_tokens: the token's own public key ──────────────────────────────
-- A CI credential is a principal like any other under ADR 0009. The environment's
-- keys are sealed to this public key; the matching private scalar lives only
-- inside the token string its creator was shown once, so the server holds a hash
-- it can check and a public key it can seal to, and nothing that opens either.
--
-- This is what makes rotation cheap. Because the public key is here, a client
-- rotating an EDK re-seals it to every service token without anybody
-- regenerating one — the v1 design gave tokens a symmetric key half and therefore
-- invalidated every token on every revocation.
--
-- Nullable: Phase 4's creation flow is what fills it, and a grant to a token
-- without one is refused rather than sealed to nothing.
ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS public_key bytea;
--> statement-breakpoint

ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS key_algorithm text;
--> statement-breakpoint

-- ── invitations.invite_public_key ───────────────────────────────────────────
-- The invitation's X25519 public key (spec §10). The inviter's client derives a
-- keypair from a 16-byte fragment, seals the relevant grants to this public half,
-- and uploads it here. **The fragment never reaches the server**: it travels to
-- the invitee out of band, over a different channel from the emailed token, so a
-- leaked email decrypts nothing and a leaked fragment authenticates nothing.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS invite_public_key bytea;
--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new table
-- automatically, so the four tables above are invisible to it until this runs.
-- Guarded, because a self-hoster who never ran the least-privilege migration has
-- no such role and must not be blocked by its absence.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON env_data_keys TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON env_hmac_keys TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON env_key_grants TO xecret_app_permissions;
		GRANT SELECT, INSERT, UPDATE, DELETE ON pending_key_grants TO xecret_app_permissions;
	END IF;
END
$$;
