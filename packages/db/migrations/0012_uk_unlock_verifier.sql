-- The second unlock verifier: the one a passkey can produce.
--
-- ── The gap this closes ──
-- `POST /api/auth/vault/unlock` proves possession by comparing the unlock
-- verifier, and that value is HKDF(SK, "xecret.v2.unlock-verifier") — a branch
-- of the Stretched Key, which exists only when a passphrase has been typed.
--
-- A passkey unlock derives no SK. What its PRF output opens is blob type 3, and
-- blob type 3 holds the User Key; there is no derivation from the UK back to SK,
-- by construction, because that one-way relationship is what makes a passphrase
-- change a single re-wrap rather than a re-encryption of everything. So a
-- browser could genuinely open the vault with a passkey — really unwrap the User
-- Key, really decrypt — and still hold nothing the unlock endpoint would accept.
-- That was a gap in the stored model, not something a cleverer client could work
-- around, and this column is the half of the fix that lives in the database.
--
-- The new branch is `xecret.v2.uk-unlock-verifier`, taking the UK as input
-- keying material (spec §3.3, §8.2). It concedes nothing: anyone who can compute
-- it already holds the UK, and therefore already holds every private key and
-- every environment key the account can reach. The proof is strictly weaker than
-- the capability it attests to.
--
-- A separate column rather than a second accepted value in `unlock_verifier_hash`,
-- because the two are different HKDF branches and must never be interchangeable.
-- One column would mean a value captured from either path satisfies both, which
-- is exactly the confusion the distinct info strings exist to prevent.
--
-- Written only by the vault setup ceremony. A passphrase change and a recovery
-- both re-wrap the User Key rather than replacing it, so this digest stays valid
-- across them and neither path touches this column.

-- ── NOT NULL, and the guard that makes it safe ──
-- There is no sensible backfill. The value is a hash of an HKDF branch of the
-- User Key, and the User Key exists only inside a browser that has been
-- unlocked — this database cannot compute it for an existing row, and inventing
-- a placeholder would leave a column whose contents claim to be a verifier and
-- are not.
--
-- So the column is NOT NULL with no default, and rows must not exist when it is
-- added. Migration 0011 created `user_keys` in this same unreleased series, so
-- on every deployment that follows the two in order the table is empty and this
-- is a no-op guard. It is written out rather than assumed because the failure it
-- prevents is silent: an `ALTER TABLE ... ADD COLUMN ... NOT NULL` against a
-- populated table fails with a message about a column, not about what the
-- operator should do instead.
--
-- If it does fire, the answer is that those pre-release vaults must go: each one
-- is a key hierarchy generated before this branch existed, and its owner can
-- create a fresh one from the setup ceremony. `DELETE FROM user_keys;` cascades
-- to the wraps and the passkeys and is the intended remedy — it destroys access
-- to anything already encrypted under them, which on a pre-release deployment is
-- nothing anyone can afford to be attached to.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'user_keys' AND column_name = 'uk_unlock_verifier_hash'
	) THEN
		IF EXISTS (SELECT 1 FROM user_keys) THEN
			RAISE EXCEPTION
				'user_keys already holds % row(s), and uk_unlock_verifier_hash has no backfill: '
				'the value is derived from a User Key that exists only in an unlocked browser. '
				'These vaults predate passkey unlock. Run DELETE FROM user_keys; — their owners '
				're-run the setup ceremony — then apply this migration again.',
				(SELECT count(*) FROM user_keys);
		END IF;

		ALTER TABLE user_keys ADD COLUMN uk_unlock_verifier_hash bytea NOT NULL;
	END IF;
END
$$;
