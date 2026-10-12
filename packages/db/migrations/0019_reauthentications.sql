-- Re-authentication for the vault reset: a forced fresh sign-in, then an
-- emailed one-time code, then a five-minute proof the reset spends once.
--
-- ── Why a table ──
-- The reset destroys a vault and has no undo, and it has to stay reachable from
-- a locked session — every caller of it is locked out by definition — so the
-- vault lock cannot stand in front of it. What stands there instead is two
-- re-authentications in a fixed order (`.local/workos-auth.md` §8 Q5): the
-- person signs in again with the identity provider told to ignore any session
-- it still holds, and *then* enters a code sent to their inbox. Each step is
-- checked against the one before it, by the server, so a row is the record of
-- where one person's attempt has got to:
--
--   signed_in_at      the forced sign-in completed, and issued `session_id`
--   code_sent_at      a code was requested (bookkeeping; the code is the
--                     provider's, and is never stored here)
--   code_failures     wrong codes presented against this attempt. Capped by
--                     the application, so the six digits cannot be walked
--                     even where the rate limiter is absent (it fails open).
--   proof_hash        the code was verified, and a proof was minted — SHA-256
--                     of it, never the proof itself
--   used_at           the reset spent the proof
--
-- ── Bound to one session, and through it to one person ──
-- `session_id` is UNIQUE: the forced sign-in issues a brand-new session, and the
-- whole attempt belongs to it. A proof minted here is refused by any other
-- session, including another session of the same account, so a second stolen
-- cookie cannot spend it.
--
-- ── Additive ──
-- A new table with no reader in older code. Apply it before deploying the code
-- that uses it; the reverse order fails only the vault-reset path, and only
-- with a 500, but there is no reason to take that.

CREATE TABLE "reauthentications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"signed_in_at" timestamp with time zone NOT NULL,
	"code_sent_at" timestamp with time zone,
	"code_failures" smallint DEFAULT 0 NOT NULL,
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
	-- Spent means a proof existed to spend.
	CONSTRAINT "reauthentications_used_check"
		CHECK ("used_at" IS NULL OR "proof_hash" IS NOT NULL),
	CONSTRAINT "reauthentications_code_failures_check" CHECK ("code_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reauthentications" ADD CONSTRAINT "reauthentications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The session going ends the attempt with it: expiry, sign-out, "sign out
-- everywhere" and account deletion all remove the row a proof hangs off.
ALTER TABLE "reauthentications" ADD CONSTRAINT "reauthentications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
