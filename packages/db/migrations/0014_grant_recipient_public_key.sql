-- The one field a grant's signature pins that the row did not carry.
--
-- ── The gap ──
-- `env_key_grants.signature` covers `recipientPublicKey` (spec §6.1): 32 raw
-- bytes of the X25519 key the two blobs were sealed to. The row stored the kind,
-- the id, the two blobs and the signer — everything in the signing payload
-- *except* that key. Verification is deferred (ADR 0009, trade-off 3), and a
-- verifier written later would therefore have had to fetch the recipient's key
-- from somewhere else to recompute the payload: `user_keys.enc_public_key` for a
-- member, `service_tokens.public_key` for a token, `invitations.public_key` for
-- an invitation.
--
-- Every one of those is **mutable**, and one of them changes routinely. A vault
-- reset replaces `user_keys.enc_public_key`; from that moment on, every honest
-- grant sealed to the old key recomputes to a different payload and verifies as
-- forged. Deferred verification would begin its life reporting tampering on rows
-- nobody touched, which is the one failure mode that teaches an operator to
-- switch the check off.
--
-- Worse in the direction that matters: the server would be supplying the single
-- field the signature exists to pin *against the server*. §6.1 states the reason
-- the key is in the payload at all — "a server cannot relabel a service-token
-- grant as a member grant, or move a valid grant between two principals that
-- share a public key, without invalidating the signature". A verifier that reads
-- that key from a table the server writes has handed the guarantee back.
--
-- So the row records what the client says it sealed to. That is not the server
-- trusting a client field: it is the row becoming self-contained, so that a
-- future verifier recomputes the payload from the row alone and then compares
-- the recorded key against whatever the principal's key is *today* as a separate,
-- legible question — "this grant was sealed to a key this account no longer has"
-- is a different sentence from "this grant's signature does not verify", and the
-- two must not be collapsed.

-- ── NOT NULL, and the guard that makes it safe ──
-- There is no backfill. The value is a public key the client chose at sealing
-- time; this database can guess it for a member grant and cannot know it for an
-- invitation whose fragment has been consumed, and a guess written into a column
-- that claims to record what was signed is worse than no column.
--
-- So it is NOT NULL with no default, and rows must not exist when it is added.
-- Migration 0013 created `env_key_grants` in this same unreleased series, so on
-- every deployment that applies the two in order the table is empty and the
-- guard is a no-op. It is written out rather than assumed for the reason 0012
-- gives: `ALTER TABLE … ADD COLUMN … NOT NULL` against a populated table fails
-- with a message about a column, not about what the operator should do instead.
--
-- If it does fire, the remedy is `DELETE FROM env_key_grants;` followed by a
-- fresh key ceremony per environment. Those grants are pre-release rows sealed
-- under keys that only ever existed in a browser, and deleting one destroys
-- access to whatever was encrypted under it — which on a pre-release deployment
-- is nothing anyone can afford to be attached to.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'env_key_grants' AND column_name = 'recipient_public_key'
	) THEN
		IF EXISTS (SELECT 1 FROM env_key_grants) THEN
			RAISE EXCEPTION
				'env_key_grants already holds rows, and recipient_public_key cannot be '
				'backfilled: it records the public key a client sealed to, which this '
				'database never saw. Delete the pre-release grants and re-run the key '
				'ceremony for each environment, then apply this migration.';
		END IF;

		ALTER TABLE env_key_grants ADD COLUMN recipient_public_key bytea NOT NULL;
	END IF;
END
$$;
--> statement-breakpoint

-- 32 bytes, checked in the database as well as in the schema. A truncated key is
-- a payload that recomputes to something else, and the failure would surface as
-- an unexplained signature mismatch years from now rather than as a rejected
-- write today.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'env_key_grants_recipient_public_key_check'
	) THEN
		ALTER TABLE env_key_grants
			ADD CONSTRAINT env_key_grants_recipient_public_key_check
			CHECK (octet_length(recipient_public_key) = 32);
	END IF;
END
$$;
