-- Retained vaults: the seven-day window after a vault reset (P23).
--
-- ── What changes ──
-- A reset used to delete the vault. Now it moves it here, in the transaction
-- that empties `user_keys`: the key row, the live passphrase wrap, every unused
-- recovery wrap, and every environment-key grant the account held as a member.
-- The account is free to set up a new vault at once. For seven days the old one
-- can be recovered — the old passphrase or a recovery code opens it in the
-- browser, which re-seals its environment keys to the new vault — and nobody can
-- delete it. Then the scheduled purge removes it.
--
-- ── The window is the database's to keep, not the application's ──
-- "Nobody can permanently delete it during the window" is enforced here, so no
-- route added later, no bug, and no injected statement running as the
-- application role can shorten it:
--
--   retained_vaults_window_check   purge_after is exactly retained_at + 168 hours
--                                  (hours, not days: a day added across a DST
--                                  change in a non-UTC session is 23 or 25 hours)
--   retained_vaults_immutable      the key material, the owner and both
--                                  timestamps never change after insert; only
--                                  the recovery bookkeeping does
--   retained_vaults_no_early_delete  DELETE is refused while purge_after is in
--                                  the future, by the database's own clock
--   …and the same refusal on the two child tables, so a vault cannot be
--   hollowed out row by row either.
--
-- An operator acting as the table owner can still disable a trigger; that is a
-- deliberate act outside the product, and it is the only way.
--
-- ── Nothing here is readable by the server ──
-- Every column is a public key, a salt, a parameter set, a digest, or the ASCII
-- of an `xk2.` blob sealed under a key this server has never held — exactly the
-- property `user_keys`, `user_key_wraps` and `env_key_grants` have, copied
-- verbatim from them.
--
-- ── Additive, and it must be applied BEFORE the code that uses it ──
-- Three new tables with no reader in older code, so applying this first is
-- harmless. Deploying the code first is not: a reset would email the archive
-- and then fail with a 500 when it tries to retain the vault — the
-- re-authentication proof already spent, so the person has to sign in and get a
-- new code to try again — the Settings → Security card would show an error, and
-- the hourly purge would fail on every run until this is applied.

CREATE TABLE "retained_vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	-- The user_keys row, verbatim.
	"enc_algorithm" text NOT NULL,
	"enc_public_key" bytea NOT NULL,
	"enc_private_key_enc" bytea NOT NULL,
	"sign_algorithm" text NOT NULL,
	"sign_public_key" bytea NOT NULL,
	"sign_private_key_enc" bytea NOT NULL,
	"kdf_salt" bytea NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"unlock_verifier_hash" bytea NOT NULL,
	-- SHA-256 of HKDF(UK, "xecret.v2.uk-unlock-verifier"): what a recovery must
	-- present to prove it opened this vault's User Key (spec §8.2).
	"uk_unlock_verifier_hash" bytea NOT NULL,
	"vault_created_at" timestamp with time zone NOT NULL,
	"vault_rotated_at" timestamp with time zone,
	-- The window.
	"retained_at" timestamp with time zone NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	-- Bookkeeping, and the only mutable columns.
	"recovered_at" timestamp with time zone,
	"recovery_failed_attempts" integer DEFAULT 0 NOT NULL,
	"recovery_locked_until" timestamp with time zone,
	CONSTRAINT "retained_vaults_window_check"
		CHECK ("purge_after" = "retained_at" + interval '168 hours'),
	CONSTRAINT "retained_vaults_digest_check"
		CHECK (octet_length("unlock_verifier_hash") = 32 AND octet_length("uk_unlock_verifier_hash") = 32),
	CONSTRAINT "retained_vaults_public_keys_check"
		CHECK (octet_length("enc_public_key") = 32 AND octet_length("sign_public_key") = 32),
	CONSTRAINT "retained_vaults_attempts_check" CHECK ("recovery_failed_attempts" >= 0),
	-- The application may write the lockout, but never past the purge: a lock that
	-- outlives the vault it guards is not a lock, only a way to hide the window.
	CONSTRAINT "retained_vaults_lock_check"
		CHECK ("recovery_locked_until" IS NULL OR "recovery_locked_until" <= "purge_after")
);
--> statement-breakpoint
ALTER TABLE "retained_vaults" ADD CONSTRAINT "retained_vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every read is "this account's vaults still inside their window".
CREATE INDEX "retained_vaults_user_idx" ON "retained_vaults" USING btree ("user_id", "purge_after");--> statement-breakpoint
-- The purge's scan.
CREATE INDEX "retained_vaults_purge_idx" ON "retained_vaults" USING btree ("purge_after");--> statement-breakpoint

-- The live passphrase wrap and every unused recovery wrap, verbatim. Superseded
-- passphrase wraps and redeemed codes are not kept: they are old credentials of
-- a key being retired, and each would be one more thing to attack.
CREATE TABLE "retained_vault_wraps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"retained_vault_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"wrap" bytea NOT NULL,
	"lookup_hash" bytea,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "retained_vault_wraps_kind_check" CHECK ("kind" IN ('passphrase', 'recovery')),
	CONSTRAINT "retained_vault_wraps_lookup_check"
		CHECK (("kind" = 'recovery') = ("lookup_hash" IS NOT NULL)),
	CONSTRAINT "retained_vault_wraps_lookup_length_check"
		CHECK ("lookup_hash" IS NULL OR octet_length("lookup_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "retained_vault_wraps" ADD CONSTRAINT "retained_vault_wraps_retained_vault_id_fk" FOREIGN KEY ("retained_vault_id") REFERENCES "public"."retained_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retained_vault_wraps_passphrase_unique" ON "retained_vault_wraps" USING btree ("retained_vault_id") WHERE "kind" = 'passphrase';--> statement-breakpoint
CREATE UNIQUE INDEX "retained_vault_wraps_lookup_unique" ON "retained_vault_wraps" USING btree ("retained_vault_id", "lookup_hash") WHERE "lookup_hash" IS NOT NULL;--> statement-breakpoint

-- Every environment-key grant the account held as a member, verbatim, at every
-- key version. `env_data_key_id` names the key; the blobs are sealed to the
-- retained vault's public key, which only its private key — under its User Key —
-- opens.
CREATE TABLE "retained_vault_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"retained_vault_id" uuid NOT NULL,
	"env_data_key_id" uuid NOT NULL,
	"edk_sealed" bytea NOT NULL,
	"ehk_sealed" bytea NOT NULL,
	"recipient_public_key" bytea NOT NULL,
	"signature" bytea NOT NULL,
	"signed_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "retained_vault_grants_key_unique" UNIQUE ("retained_vault_id", "env_data_key_id")
);
--> statement-breakpoint
ALTER TABLE "retained_vault_grants" ADD CONSTRAINT "retained_vault_grants_retained_vault_id_fk" FOREIGN KEY ("retained_vault_id") REFERENCES "public"."retained_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retained_vault_grants" ADD CONSTRAINT "retained_vault_grants_env_data_key_id_fk" FOREIGN KEY ("env_data_key_id") REFERENCES "public"."env_data_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retained_vault_grants" ADD CONSTRAINT "retained_vault_grants_signed_by_user_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retained_vault_grants_key_idx" ON "retained_vault_grants" USING btree ("env_data_key_id");--> statement-breakpoint

-- ── The window, kept by the database ──────────────────────────────────────────
--
-- Every function below runs with `search_path = pg_catalog, pg_temp` and names
-- `public.retained_vaults` in full. Without both, a session could shadow the
-- table the child trigger reads with a temporary one of the same name — which
-- any role may create — and the trigger would consult *that*, find nothing, and
-- let the delete through; or shadow `now()` with a function in a schema it can
-- write. `pg_catalog` first means the built-ins are always the built-ins, and
-- `pg_temp` named last means it is never searched before them.

CREATE FUNCTION "retained_vault_refuse_early_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF OLD.purge_after > now() THEN
		RAISE EXCEPTION 'retained vault % is inside its seven-day window until %', OLD.id, OLD.purge_after
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "retained_vaults_no_early_delete"
	BEFORE DELETE ON "retained_vaults"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_refuse_early_delete"();--> statement-breakpoint

-- Only the recovery bookkeeping may change. A purge_after moved earlier would be
-- an early delete by two statements instead of one.
CREATE FUNCTION "retained_vault_refuse_rewrite"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	IF (NEW.id, NEW.user_id, NEW.enc_algorithm, NEW.enc_public_key, NEW.enc_private_key_enc,
		NEW.sign_algorithm, NEW.sign_public_key, NEW.sign_private_key_enc, NEW.kdf_salt,
		NEW.kdf_params, NEW.unlock_verifier_hash, NEW.uk_unlock_verifier_hash,
		NEW.vault_created_at, NEW.vault_rotated_at, NEW.retained_at, NEW.purge_after)
		IS DISTINCT FROM
		(OLD.id, OLD.user_id, OLD.enc_algorithm, OLD.enc_public_key, OLD.enc_private_key_enc,
		OLD.sign_algorithm, OLD.sign_public_key, OLD.sign_private_key_enc, OLD.kdf_salt,
		OLD.kdf_params, OLD.unlock_verifier_hash, OLD.uk_unlock_verifier_hash,
		OLD.vault_created_at, OLD.vault_rotated_at, OLD.retained_at, OLD.purge_after)
	THEN
		RAISE EXCEPTION 'a retained vault is immutable except for its recovery bookkeeping'
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "retained_vaults_immutable"
	BEFORE UPDATE ON "retained_vaults"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_refuse_rewrite"();--> statement-breakpoint

-- A child row goes only with its vault: refused while the vault exists inside
-- its window. During the purge's cascade the vault row is already gone, so the
-- lookup finds nothing and the cascade proceeds.
CREATE FUNCTION "retained_vault_part_refuse_early_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
	window_ends timestamp with time zone;
BEGIN
	SELECT purge_after INTO window_ends FROM public.retained_vaults WHERE id = OLD.retained_vault_id;
	IF FOUND AND window_ends > now() THEN
		RAISE EXCEPTION 'retained vault % is inside its seven-day window until %', OLD.retained_vault_id, window_ends
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "retained_vault_part_refuse_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION 'a retained vault is immutable except for its recovery bookkeeping'
		USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "retained_vault_wraps_no_early_delete"
	BEFORE DELETE ON "retained_vault_wraps"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_part_refuse_early_delete"();--> statement-breakpoint
CREATE TRIGGER "retained_vault_wraps_immutable"
	BEFORE UPDATE ON "retained_vault_wraps"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_part_refuse_update"();--> statement-breakpoint
CREATE TRIGGER "retained_vault_grants_no_early_delete"
	BEFORE DELETE ON "retained_vault_grants"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_part_refuse_early_delete"();--> statement-breakpoint
CREATE TRIGGER "retained_vault_grants_immutable"
	BEFORE UPDATE ON "retained_vault_grants"
	FOR EACH ROW EXECUTE FUNCTION "retained_vault_part_refuse_update"();--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new
-- table automatically (0010 revoked the default privileges). Guarded, because
-- a self-hoster who never ran the least-privilege migration has no such role
-- and must not be blocked by its absence.
--
-- Narrower than any other table's, and each narrowing is a second wall behind
-- the triggers rather than a replacement for them:
--
--   retained_vaults        SELECT, INSERT, DELETE, and UPDATE of the three
--                          bookkeeping columns only. The reset inserts, the
--                          recovery reads and counts, the purge deletes — and
--                          the triggers refuse a delete inside the window. The
--                          key material and the window cannot be updated by the
--                          role at all, before any trigger is consulted.
--   retained_vault_wraps   SELECT and INSERT. The application never updates or
--   retained_vault_grants  deletes these rows: they go with their vault, by the
--                          foreign key's cascade, which runs as the table's
--                          owner and so needs no privilege of the caller.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, DELETE ON retained_vaults TO xecret_app_permissions;
		GRANT UPDATE (recovered_at, recovery_failed_attempts, recovery_locked_until)
			ON retained_vaults TO xecret_app_permissions;
		GRANT SELECT, INSERT ON retained_vault_wraps TO xecret_app_permissions;
		GRANT SELECT, INSERT ON retained_vault_grants TO xecret_app_permissions;
	END IF;
END
$$;
