import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './columns';
import { sessions, users } from './identity';

/**
 * One person's attempt to re-authenticate for the vault reset. See migration
 * 0019 for the whole argument; the short version is that the reset has no undo,
 * stays reachable from a locked session, and so is guarded by two
 * re-authentications in a fixed order — a fresh sign-in, then an emailed code
 * (and the user's authenticator, when WorkOS asks for it) — whose progress the
 * server, not the client, keeps.
 *
 * Bound to the session the fresh sign-in issued (`session_id`, unique), and
 * through it to that session's user. Nothing here is a credential: the proof
 * and WorkOS's pending-authentication token are stored as their SHA-256, and
 * the emailed code is WorkOS's and never lands in this table at all.
 */
export const reauthentications = pgTable(
  'reauthentications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** When the fresh sign-in completed — the first lock. */
    signedInAt: timestamp('signed_in_at', { withTimezone: true }).notNull(),
    /** When the emailed code was last requested. No guess is taken before it. */
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    /** Guesses reserved against this attempt, before WorkOS is asked. */
    codeAttempts: smallint('code_attempts').notNull().default(0),
    /** Codes requested on this attempt, reserved before WorkOS is asked to send one. */
    codeSends: smallint('code_sends').notNull().default(0),
    /** SHA-256 of WorkOS's pending-authentication token, while it wants a TOTP. */
    mfaPendingHash: bytea('mfa_pending_hash'),
    /** The TOTP factor to challenge, alongside `mfaPendingHash`. */
    mfaFactorId: text('mfa_factor_id'),
    /** SHA-256 of the proof minted once the second lock opened. */
    proofHash: bytea('proof_hash').unique(),
    proofExpiresAt: timestamp('proof_expires_at', { withTimezone: true }),
    /** When the reset spent the proof. Set once; a spent proof is refused. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reauthentications_user_idx').on(t.userId, t.signedInAt),
    check(
      'reauthentications_proof_pair_check',
      sql`(${t.proofHash} is null) = (${t.proofExpiresAt} is null)`,
    ),
    check(
      'reauthentications_proof_hash_length_check',
      sql`${t.proofHash} is null or octet_length(${t.proofHash}) = 32`,
    ),
    check(
      'reauthentications_mfa_pending_hash_length_check',
      sql`${t.mfaPendingHash} is null or octet_length(${t.mfaPendingHash}) = 32`,
    ),
    check(
      'reauthentications_mfa_pair_check',
      sql`(${t.mfaPendingHash} is null) = (${t.mfaFactorId} is null)`,
    ),
    check('reauthentications_used_check', sql`${t.usedAt} is null or ${t.proofHash} is not null`),
    check('reauthentications_code_attempts_check', sql`${t.codeAttempts} >= 0`),
    check('reauthentications_code_sends_check', sql`${t.codeSends} >= 0`),
  ],
);
