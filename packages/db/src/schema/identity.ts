import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, citext, inet } from './columns';

/**
 * Identity. See docs/adr/0003-firebase-as-identity-provider.md.
 *
 * The provider authenticates; xecret owns the session. The provider id column
 * is the only coupling, which is what made adding a second one a column rather
 * than a restructuring — and is exactly what this table is now doing.
 *
 * ── Two provider columns, on purpose, for now ──
 * `workos_user_id` is the identity going forward. `firebase_uid` stays, and
 * stays *nullable*, for the length of the migration:
 *
 *   - It is the join key the backfill matches on, so it must survive the import.
 *   - It is the rollback. Until it is deliberately dropped — a separate
 *     migration, well after production cutover — the old provider remains a
 *     working answer to "who is this person", and a cutover that goes wrong is
 *     recoverable rather than terminal.
 *
 * Nullable because a user who signs up after the swap never had a Firebase
 * account, and forcing a synthetic value would put a lie in the column the
 * rollback depends on being true.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /**
     * Retired, retained. Null for anybody who joined after the WorkOS swap.
     *
     * Still unique where present: two rows claiming one Firebase account would
     * make the backfill ambiguous in exactly the place it must not be.
     */
    firebaseUid: text('firebase_uid').unique(),
    /**
     * The WorkOS user id — `user_…`. Null only between a row being created and
     * its first authenticated login during the transition.
     */
    workosUserId: text('workos_user_id').unique(),
    email: citext('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('users_firebase_uid_idx')
      .on(t.firebaseUid)
      .where(sql`${t.deletedAt} is null`),
    // Mirrors the Firebase index exactly, including the partial predicate: the
    // lookup on every single login filters soft-deleted rows, and an index that
    // did not would make the hot path of the whole product read rows it must
    // then discard.
    index('users_workos_user_id_idx')
      .on(t.workosUserId)
      .where(sql`${t.deletedAt} is null`),
    // A row must be reachable by *some* provider. Without this, a bug in the
    // linking pass could write a user nobody can ever authenticate as — a row
    // that exists, owns organisations and secrets, and has no way back in.
    check(
      'users_identity_present_check',
      sql`${t.firebaseUid} is not null or ${t.workosUserId} is not null`,
    ),
  ],
);

/**
 * Sessions issued by xecret, not by Firebase.
 *
 * Only the SHA-256 of the opaque 256-bit cookie token is stored, so a database
 * dump yields hashes rather than usable sessions (threat T6).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * When this session last unlocked its owner's vault. `NULL` means never.
     *
     * A session is authenticated the moment it is created and **unlocked** only
     * once this is set and recent — see `isVaultUnlocked` in
     * `@xecret/core/auth`. Keeping the two apart on the row is what lets a
     * 30-day cookie coexist with an 8-hour reach into key material: signing out
     * everywhere still revokes, and locking merely clears this.
     */
    vaultUnlockedAt: timestamp('vault_unlocked_at', { withTimezone: true }),
  },
  (t) => [
    // Hot path: every authenticated request resolves the actor through this.
    index('sessions_lookup_idx')
      .on(t.tokenHash)
      .where(sql`${t.revokedAt} is null`),
    // Powers the "active devices" list and "sign out everywhere".
    index('sessions_user_idx').on(t.userId, t.createdAt.desc()),
  ],
);
