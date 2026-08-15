import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext, inet } from './columns';

/**
 * Identity. See docs/adr/0003-firebase-as-identity-provider.md.
 *
 * Firebase authenticates; xecret owns the session. `firebase_uid` is the only
 * coupling to the provider, so adding a second `IdentityProvider` later means
 * adding a column, not restructuring.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    firebaseUid: text('firebase_uid').notNull().unique(),
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
     * When this session last had its PIN accepted. `NULL` means never.
     *
     * A session is authenticated the moment it is created and **unlocked** only
     * once this is set and recent — see `isSessionUnlocked` in
     * `@xecret/core/auth`. Keeping the two apart on the row is what lets a
     * 30-day cookie coexist with an 8-hour reach into secrets: signing out
     * everywhere still revokes, and locking merely clears this.
     */
    pinVerifiedAt: timestamp('pin_verified_at', { withTimezone: true }),
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

/**
 * The unlock PIN, one row per user who has set one.
 *
 * A separate table rather than columns on `users`, for three reasons that all
 * point the same way:
 *
 *  - **The hot path stays narrow.** `users` is joined on every authenticated
 *    request; the PIN material is read on exactly one endpoint.
 *  - **Absence is meaningful.** No row means "has not set a PIN yet", which is
 *    the state that drives the setup screen. Three nullable columns on `users`
 *    would encode the same thing less clearly and let two of them disagree.
 *  - **It can be revoked wholesale.** `DELETE FROM user_pins WHERE user_id = …`
 *    is the complete reset, with no chance of leaving a stale attempt counter
 *    behind.
 */
export const userPins = pgTable(
  'user_pins',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `pbkdf2-sha256$<iterations>$<salt>$<hash>`, all base64url.
     *
     * Self-describing so the iteration count can be raised without a migration:
     * an old row keeps verifying against the cost it was written with, and is
     * re-hashed the next time its owner successfully unlocks.
     */
    pinHash: text('pin_hash').notNull(),
    /** Consecutive failures since the last success. Drives the escalating delay. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * Minutes of dashboard idleness before the client locks itself; `0` never.
     *
     * Lives here rather than on `users` because it is a property of the PIN
     * protection — meaningless without a PIN to ask for — and this table is
     * read exactly where the lock state is computed. The menu of legal values
     * is `AUTO_LOCK_MINUTES_OPTIONS` in `@xecret/core/auth`; the CHECK below
     * restates it so a row cannot hold an interval no client offers.
     */
    autoLockMinutes: integer('auto_lock_minutes').notNull().default(10),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_pins_auto_lock_check', sql`${t.autoLockMinutes} in (0, 5, 10, 20, 30, 45, 60)`),
  ],
);

/**
 * Outstanding "I forgot my PIN" links.
 *
 * Only the SHA-256 of the emailed token is stored, exactly as for sessions and
 * CLI tokens: a database dump yields hashes rather than working reset links.
 *
 * `consumed_at` rather than a delete, so a link that has already been used is
 * distinguishable from one that never existed. The two get the same answer at
 * the API — telling them apart would confirm to a stranger that an address has
 * an account — but the difference is what makes a support conversation about a
 * reset that "did not arrive" answerable.
 */
export const pinResetTokens = pgTable(
  'pin_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Recorded so a reset can be traced in an incident. */
    requestedIp: inet('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pin_reset_tokens_lookup_idx')
      .on(t.tokenHash)
      .where(sql`${t.consumedAt} is null`),
    // Lets a new request invalidate this user's outstanding links in one write,
    // and powers the cleanup of expired rows.
    index('pin_reset_tokens_user_idx').on(t.userId, t.createdAt.desc()),
  ],
);
