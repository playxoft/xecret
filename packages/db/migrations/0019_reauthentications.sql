-- Re-authentication for the vault reset: a fresh sign-in, then an emailed
-- one-time code, then a five-minute proof the reset spends once.
--
-- ── Why a table ──
-- The reset destroys a vault and has no undo, and it has to stay reachable from
-- a locked session — every caller of it is locked out by definition — so the
-- vault lock cannot stand in front of it. What stands there instead is two
-- re-authentications in a fixed order (`.local/workos-auth.md` §8 Q5): the
-- person signs in again, and *then* enters a code sent to their inbox. Each
-- step is checked against the one before it, by the server, so a row is the
-- record of where one person's attempt has got to:
--
--   signed_in_at      the fresh sign-in completed, and issued `session_id`
--   code_sent_at      a code was requested (bookkeeping; the code is WorkOS's,
--                     and is never stored here). No guess is accepted on an
--                     attempt whose code was never requested.
--   code_attempts     guesses reserved against this attempt — the emailed code
--                     and the authenticator step alike — counted *before*
--                     WorkOS is asked, so a guess costs the same whatever
--                     WorkOS answers and however many arrive at once. Capped by
--                     the application, per attempt and per user per day.
--   code_sends        codes requested on this attempt, counted *before* WorkOS
--                     is asked to send one, under the same lock as the guesses.
--                     Capped by the application per attempt, so a session that
--                     passed lock one cannot turn it into a stream of mail to
--                     the account's inbox: the rate limiter in front is per
--                     location and fails open.
--   mfa_pending_hash  when the emailed code was right but WorkOS wants the
--   mfa_factor_id     user's authenticator too: SHA-256 of WorkOS's pending-
--                     authentication token (the browser holds the token; the
--                     hash binds it to this attempt) and the TOTP factor to
--                     challenge.
--   proof_hash        the attempt succeeded and a proof was minted — SHA-256
--                     of it, never the proof itself
--   used_at           the reset spent the proof
--
-- ── Bound to one session, and through it to one person ──
-- `session_id` is UNIQUE: the fresh sign-in issues a brand-new session, and the
-- whole attempt belongs to it. A proof minted here is refused by any other
-- session, including another session of the same account, so a second stolen
-- cookie cannot spend it.
--
-- ── When a row goes ──
-- Sessions are *revoked* by UPDATE (sign-out, "sign out everywhere", account
-- deletion), not deleted, so a revoked session's row stays — harmlessly: the
-- reset that would spend its proof has to authenticate with that session, and
-- a revoked session authenticates nothing. The row is removed by cascade only
-- when the session row itself is deleted (expired-session cleanup) or the user
-- row is.
--
-- ── Additive ──
-- A new table with no reader in older code. Apply it before deploying the code
-- that uses it; the reverse order fails only the vault-reset path, and only
-- with a 500, but there is no reason to take that. Amended in review before it
-- was applied anywhere.

CREATE TABLE "reauthentications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"signed_in_at" timestamp with time zone NOT NULL,
	"code_sent_at" timestamp with time zone,
	"code_attempts" smallint DEFAULT 0 NOT NULL,
	"code_sends" smallint DEFAULT 0 NOT NULL,
	"mfa_pending_hash" "bytea",
	"mfa_factor_id" text,
	"proof_hash" "bytea",
	"proof_expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reauthentications_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "reauthentications_proof_hash_unique" UNIQUE("proof_hash"),
	-- A proof and its expiry exist together or not at all: a proof with no
	-- expiry would be a proof that never stops working.
	CONSTRAINT "reauthentications_proof_pair_check"
		CHECK (("proof_hash" IS NULL) = ("proof_expires_at" IS NULL)),
	-- A SHA-256 digest and nothing else. A raw proof in this column is the one
	-- mistake that would make a database read worth the same as the proof.
	CONSTRAINT "reauthentications_proof_hash_length_check"
		CHECK ("proof_hash" IS NULL OR octet_length("proof_hash") = 32),
	-- The same rule for the pending-authentication token, which WorkOS would
	-- accept back with an authenticator code: only its hash is kept.
	CONSTRAINT "reauthentications_mfa_pending_hash_length_check"
		CHECK ("mfa_pending_hash" IS NULL OR octet_length("mfa_pending_hash") = 32),
	CONSTRAINT "reauthentications_mfa_pair_check"
		CHECK (("mfa_pending_hash" IS NULL) = ("mfa_factor_id" IS NULL)),
	-- Spent means a proof existed to spend.
	CONSTRAINT "reauthentications_used_check"
		CHECK ("used_at" IS NULL OR "proof_hash" IS NOT NULL),
	CONSTRAINT "reauthentications_code_attempts_check" CHECK ("code_attempts" >= 0),
	CONSTRAINT "reauthentications_code_sends_check" CHECK ("code_sends" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reauthentications" ADD CONSTRAINT "reauthentications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reauthentications" ADD CONSTRAINT "reauthentications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The per-user guess budget sums one account's recent attempts on every guess,
-- and the user foreign key's cascade reads by `user_id` too.
CREATE INDEX "reauthentications_user_idx"
	ON "reauthentications" USING btree ("user_id", "signed_in_at");--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new
-- table automatically (0010 revoked the default privileges). Guarded, because
-- a self-hoster who never ran the least-privilege migration has no such role
-- and must not be blocked by its absence. Without this, every vault-reset
-- request on a least-privilege deployment fails with "permission denied".
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON reauthentications TO xecret_app_permissions;
	END IF;
END
$$;
