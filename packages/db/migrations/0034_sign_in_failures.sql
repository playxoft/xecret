-- Sign-in attempts against one throttle pool — the durable brake on guessing a
-- password or an emailed code on xecret's own sign-in page.
--
-- ── Why a table, when there is a rate limiter ──
-- `RL_LOGIN` is Cloudflare's rate-limit binding: per data centre, keyed on what
-- a request carries, and failing open when absent. Against somebody rotating
-- addresses and colos it is a speed bump. WorkOS limits attempts per address
-- too, but that limit is WorkOS's to change. This counter is ours, global, and
-- survives every isolate. The policy — free attempts, the backoff, its ceiling,
-- the budget arithmetic, the two pools — is
-- `apps/web/src/server/sign-in-throttle.ts`.
--
-- ── Pools ──
-- A row is one pool: an address, shared by every browser that is not known to
-- it, or one known device (`__Host-xecret_known_device`, earned by signing in)
-- for the address it was earned for. So somebody guessing at an address can
-- lock its shared pool, and never the owner's own browser.
--
-- ── Counted first ──
-- An attempt is counted *before* WorkOS is asked, in one statement that also
-- refuses it when the pool is locked and opens the next lockout from the new
-- count. Concurrent guesses therefore queue on the row: at the end of the free
-- attempts exactly one is admitted, and it locks the pool for the rest. A
-- success deletes the row; an attempt WorkOS never judged is refunded.
-- `last_attempt_id` is how that one statement tells its caller whether *its*
-- attempt was admitted: an admitted attempt writes its own id, a refused one
-- leaves the row as it was.
--
-- ── What a row holds ──
-- `subject_hash` is an HMAC — under a key derived from the deployment's cookie
-- secret — of the pool's name (`address:<lower-cased address>` or
-- `device:<id>`), never the address itself, and not a plain hash of it either:
-- a table written for addresses nobody owns as readily as for real ones must
-- not be checkable against a list of candidate addresses by anybody who reads
-- it, or reads a log line that quotes a prefix of it.
--
-- Rows are pruned once their last attempt is a day old and any lockout has
-- ended (`pruneSignInFailures`, from the scheduled worker).
--
-- ── Read this before running it ──
-- Additive only: one new table. The build that ships with it reads and writes
-- it on every in-app sign-in, so this migration must be applied BEFORE that
-- build is deployed — a missing table refuses every password and code sign-in
-- (it fails closed). Google, single sign-on and the callback do not touch it.

CREATE TABLE "sign_in_failures" (
	"subject_hash" bytea PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_id" uuid,
	CONSTRAINT "sign_in_failures_subject_hash_length_check"
		CHECK (octet_length("subject_hash") = 32),
	CONSTRAINT "sign_in_failures_failed_attempts_check" CHECK ("failed_attempts" >= 0)
);--> statement-breakpoint

-- The prune: rows whose last attempt is old.
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
