import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
