-- Unlock convenience: the auto-lock preference becomes the server's own window,
-- and a browser may enrol a device PIN against a server-held pepper.
--
-- ── What changes about auto-lock, and why it is a relaxation and a tightening ──
-- `user_keys.auto_lock_minutes` has existed since 0008 (as `user_pins.auto_lock_minutes`,
-- carried across by 0011). Until now it drove one thing only: a timer in the
-- browser. The server's own gate — how long `sessions.vault_unlocked_at` counts
-- as unlocked — was a constant eight hours that no user could see or influence,
-- so a client that simply never ran the timer kept a session the server still
-- considered unlocked for the rest of the working day, whatever the account had
-- asked for.
--
-- From here the column is the *only* number: the client timer and the server gate
-- read the same preference, so they cannot disagree. That makes the column part
-- of a security control rather than a convenience, and the shape changes to match:
--
--   NULL          the account has expressed no preference; the application's
--                 default applies. Nullable rather than DEFAULT 60 because
--                 "never chose" and "chose an hour" are different facts, and only
--                 the first may be redefined later without rewriting anybody's row.
--   15 … 720      minutes. The floor is what stops a preference from being a
--                 denial of service against its own owner; the ceiling is half a
--                 day, which is what the "until this browser closes" option stores
--                 (that option is really ended by the tab dying, not by this number).
--
-- `0` — "never" — is gone, and its removal is the point rather than a casualty.
-- A preference the server now honours cannot be allowed to say "this session
-- stays unlocked forever": that is not an idle timer any more, it is an
-- indefinitely replayable cookie.
--
-- ── The remap, stated row by row ──
-- Every live value came from the old menu (0, 5, 10, 20, 30, 45, 60), and each is
-- mapped to the nearest option the new menu actually offers, so that the settings
-- page can render every stored value as one of its own items:
--
--   0  (never)    → NULL   the only value with no honest equivalent; it becomes
--                          "no preference", which is the default hour
--   5, 10, 20, 30 → 15     everything closer to a quarter of an hour than to one
--   45            → 60
--   60            → 60     (already a menu item; the WHERE below skips it)
--
-- "Nearest" is measured, not eyeballed: 37 is the midpoint of 15 and 60, so the
-- boundary sits there. That is what puts 30 with 15 rather than with 60 — it is
-- fifteen minutes from one and thirty from the other — and it is the same answer
-- `nearestAutoLockOption` gives, which is what the settings picker will render
-- the row as. The two disagreeing would mean a page that highlights one interval
-- while the gate enforces another.
--
-- Anything outside the old menu — impossible under the old CHECK, but a
-- hand-edited row is not impossible — is clamped into range instead of being
-- rejected, because failing a migration over one row is worse than storing the
-- nearest legal value. Tightening is the safe direction to round in, which is
-- the other reason the boundary is a midpoint rather than a ceiling.
--
-- ── Order ──
-- The CHECK is dropped before the values move, because the intermediate state
-- (NULLs in a NOT NULL column) satisfies neither constraint; the new CHECK is
-- added last, against data that has already been shown to satisfy it.

-- ── user_keys.auto_lock_minutes ─────────────────────────────────────────────
ALTER TABLE user_keys DROP CONSTRAINT IF EXISTS user_keys_auto_lock_check;
--> statement-breakpoint

ALTER TABLE user_keys ALTER COLUMN auto_lock_minutes DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE user_keys ALTER COLUMN auto_lock_minutes DROP NOT NULL;
--> statement-breakpoint

UPDATE user_keys
	SET auto_lock_minutes = CASE
		WHEN auto_lock_minutes = 0 THEN NULL
		WHEN auto_lock_minutes <= 37 THEN 15
		WHEN auto_lock_minutes <= 720 THEN greatest(auto_lock_minutes, 60)
		ELSE 720
	END
	WHERE auto_lock_minutes IS NOT NULL
	  AND auto_lock_minutes NOT IN (15, 60, 240, 720);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'user_keys_auto_lock_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE user_keys
			ADD CONSTRAINT user_keys_auto_lock_check
			CHECK (auto_lock_minutes IS NULL OR auto_lock_minutes BETWEEN 15 AND 720);
	END IF;
END
$$;
--> statement-breakpoint

-- ── vault_pin_peppers ───────────────────────────────────────────────────────
-- One row per browser that has enrolled a six-digit device PIN.
--
-- ── What this table is for, and what it deliberately cannot do ──
-- A six-digit PIN is 10^6 guesses — offline, that is no protection at all. So the
-- PIN alone never opens anything. The wrap that actually holds the User Key lives
-- in that browser's `localStorage` and **never reaches this server**; it is
-- encrypted under `HKDF(pinKey ‖ pepper)`, and `pepper` is the 32 random bytes in
-- this row. Whoever holds the device but not the pepper has a ciphertext they
-- cannot attack; whoever holds this table but not the device has 32 bytes that
-- decrypt nothing, anywhere. The unlock is the moment those halves meet, and it
-- happens under a server-side attempt counter, which is what turns 10^6 offline
-- guesses into five online ones.
--
-- `verifier_hash` is how the server decides whether to release the pepper:
-- `SHA-256(HKDF(pinKey, "xecret.v2.pin-verifier"))`, a *sibling* branch of the
-- PIN-derived key, exactly as `user_keys.unlock_verifier_hash` is a sibling of the
-- passphrase wrap key. Possessing it opens nothing (crypto spec §3.3, §8).
--
-- ── The honest trade-off, recorded here as well as in the settings UI ──
-- A server that colludes with somebody holding the device can brute-force the six
-- digits: it has the pepper and they have the wrap. That is a real weakening of
-- the zero-knowledge property and it is why the PIN is opt-in per browser, why
-- the passphrase remains the root, and why no flow enables this by default.
--
-- ── Why `attempts` is a column and not a counter in an isolate ──
-- The same reason `user_keys.failed_attempts` is: a counter that lives in a
-- Worker isolate is a counter an attacker resets by waiting for the isolate to be
-- recycled. At five, the row is deleted rather than locked out — the wrap in that
-- browser can no longer be opened by anyone who never saw the pepper it was built
-- under, and the passphrase is the only way back in. That is the correct end state
-- for a credential whose whole security budget is the attempt limit.
--
-- The qualification matters, and it is why `pepper` is rewritten on every
-- successful unlock rather than only at enrolment. The value is handed to the
-- client each time it opens the wrap, so it passes through a browser and a TLS
-- session on every use; without rotation, one interception plus a copy of that
-- browser's profile would outlive any later revocation, because the pair no
-- longer needs this server. Rotating narrows the exposure to a single unlock.
--
-- The primary key is `(user_id, device_id)` rather than `device_id` alone. A
-- device id is generated by the client, so it is not a global name and must not be
-- treated as one: two accounts enrolling on the same browser are two independent
-- enrolments, and a single-column key would make the second collide with — or
-- silently overwrite — the first.
CREATE TABLE IF NOT EXISTS vault_pin_peppers (
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	device_id uuid NOT NULL,
	pepper bytea NOT NULL,
	verifier_hash bytea NOT NULL,
	attempts integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz,
	PRIMARY KEY (user_id, device_id)
);
--> statement-breakpoint

DO $$
BEGIN
	-- 32 bytes each, checked here as well as in the application. A truncated
	-- pepper is a wrap key with less entropy than the design claims, and the
	-- failure would show up as a successful enrolment rather than as an error.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'vault_pin_peppers_pepper_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE vault_pin_peppers
			ADD CONSTRAINT vault_pin_peppers_pepper_check
			CHECK (octet_length(pepper) = 32 AND octet_length(verifier_hash) = 32);
	END IF;

	-- The attempt counter is the entire security budget of a six-digit PIN, so a
	-- negative or runaway value is worth refusing at the database rather than
	-- discovering as an unlock that never locks out.
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
			WHERE conname = 'vault_pin_peppers_attempts_check'
			  AND connamespace = current_schema()::regnamespace
	) THEN
		ALTER TABLE vault_pin_peppers
			ADD CONSTRAINT vault_pin_peppers_attempts_check
			CHECK (attempts >= 0 AND attempts <= 5);
	END IF;
END
$$;
--> statement-breakpoint

-- "Which browsers has this account enrolled?" — the settings list, and the
-- revoke-everything sweep that a passphrase change, a recovery and a vault reset
-- each have to run, because all three may rotate the User Key and every stale
-- wrap must die server-side too.
CREATE INDEX IF NOT EXISTS vault_pin_peppers_user_idx
	ON vault_pin_peppers (user_id, created_at DESC);
--> statement-breakpoint

-- ── grants ──────────────────────────────────────────────────────────────────
-- The application role holds no DDL rights and is granted nothing on a new table
-- automatically, so `vault_pin_peppers` is invisible to it until this runs.
-- Guarded, because a self-hoster who never ran the least-privilege migration has
-- no such role and must not be blocked by its absence.
--
-- DELETE is included and is not incidental: burning the row after five failures
-- is the control, not a cleanup job.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xecret_app_permissions') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON vault_pin_peppers TO xecret_app_permissions;
	END IF;
END
$$;
