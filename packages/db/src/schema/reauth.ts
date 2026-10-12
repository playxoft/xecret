import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './columns';
import { sessions, users } from './identity';

/**
 * One person's attempt to re-authenticate for the vault reset. See migration
 * 0019 for the whole argument; the short version is that the reset has no undo,
 * stays reachable from a locked session, and so is guarded by two
 * re-authentications in a fixed order — a forced fresh sign-in, then an emailed
 * code — whose progress the server, not the client, keeps.
 *
 * Bound to the session the forced sign-in issued (`session_id`, unique), and
 * through it to that session's user. Nothing here is a credential: the proof is
 * stored as its SHA-256, and the emailed code is the provider's and never lands
 * in this table at all.
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
    /** When the forced fresh sign-in completed — the first lock. */
    signedInAt: timestamp('signed_in_at', { withTimezone: true }).notNull(),
    /** When the emailed code was last requested. Bookkeeping only. */
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    /** Wrong codes presented against this attempt; the application caps it. */
    codeFailures: smallint('code_failures').notNull().default(0),
    /** SHA-256 of the proof minted once the code verified — the second lock. */
    proofHash: bytea('proof_hash').unique(),
    proofExpiresAt: timestamp('proof_expires_at', { withTimezone: true }),
    /** When the reset spent the proof. Set once; a spent proof is refused. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'reauthentications_proof_pair_check',
      sql`(${t.proofHash} is null) = (${t.proofExpiresAt} is null)`,
    ),
    check(
      'reauthentications_proof_hash_length_check',
      sql`${t.proofHash} is null or octet_length(${t.proofHash}) = 32`,
    ),
    check('reauthentications_used_check', sql`${t.usedAt} is null or ${t.proofHash} is not null`),
    check('reauthentications_code_failures_check', sql`${t.codeFailures} >= 0`),
  ],
);
