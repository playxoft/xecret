-- Failed in-app sign-in attempts, per address — the durable brake on guessing
-- a password or an emailed code on xecret's own sign-in page.
--
-- ── Why a table, when there is a rate limiter ──
-- `RL_LOGIN` is Cloudflare's rate-limit binding: per data centre, keyed on what
-- a request carries, and failing open when absent. Against somebody rotating
-- addresses and colos it is a speed bump. WorkOS limits attempts per address
-- too, but that limit is WorkOS's to change, and it is also a lever for
-- locking the real owner out. This counter is ours, global, and survives every
-- isolate: consecutive failures against one address, and the lockout they
-- earned, checked before WorkOS is asked and cleared by a success. The policy
-- — how many free failures, how the delay grows, its ceiling, and the budget
-- arithmetic — is `apps/web/src/server/sign-in-throttle.ts`.
--
-- ── What a row holds ──
-- The SHA-256 of the address, lower-cased — never the address. The table is
-- written for addresses nobody owns as readily as for real ones (it is what a
-- guesser touches), and a list of every address somebody tried is not
-- something this database should be able to answer.
--
-- Rows are pruned once their last failure is a day old and any lockout has
-- ended (`pruneSignInFailures`, from the scheduled worker).
--
-- ── Read this before running it ──
-- Additive only: one new table. The build that ships with it reads and writes
-- it on every in-app sign-in, so this migration must be applied BEFORE that
-- build is deployed — a missing table is a 500 on every password and code
-- sign-in. (Google, single sign-on and the callback do not touch it.)

CREATE TABLE "sign_in_failures" (
	"subject_hash" bytea PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_failures_subject_hash_length_check"
		CHECK (octet_length("subject_hash") = 32),
	CONSTRAINT "sign_in_failures_failed_attempts_check" CHECK ("failed_attempts" >= 0)
);--> statement-breakpoint

-- The prune: rows whose last failure is old.
CREATE INDEX "sign_in_failures_last_failed_at_idx"
	ON "sign_in_failures" USING btree ("last_failed_at");--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON sign_in_failures TO xecret_app_permissions;
	END IF;
END
$$;
