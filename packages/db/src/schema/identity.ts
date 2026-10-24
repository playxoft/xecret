import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SignInMethod } from '@xecret/core/audit';
import { bytea, citext, inet } from './columns';

/**
 * Identity. See docs/adr/0010-workos-as-identity-provider.md, which superseded
 * the Firebase design of docs/adr/0003-firebase-as-identity-provider.md.
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
     * The WorkOS user id — `user_…`. Null for an account that has not signed
     * in through WorkOS yet: every row from the Firebase era, until the backfill
     * or its first WorkOS login links it.
     *
     * The unique constraint's own index is the lookup index. There is no
     * partial one beside it, unlike `users_firebase_uid_idx`: the linking pass
     * reads this column *including* soft-deleted rows, on purpose, so that a
     * deleted account is refused as deleted rather than taken for nobody — and
     * an index that left those rows out could not answer that read.
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
    // A row must be reachable by *some* provider. Without this, a bug in the
    // linking pass could write a user nobody can ever authenticate as — a row
    // that exists, owns organisations and secrets, and has no way back in.
    //
    // Dropping `firebase_uid` drops this constraint with it, silently; the
    // decommission migration must put an equivalent back. See 0018.
    check(
      'users_identity_present_check',
      sql`${t.firebaseUid} is not null or ${t.workosUserId} is not null`,
    ),
    // Only a WorkOS user id may be stored as one. The last of three checks of
    // the same pattern (`WORKOS_USER_ID_PATTERN` in core, then the linking
    // pass), and the one that holds for a backfill script or a psql session.
    // A WorkOS id-format change needs a migration here. See 0018.
    check('users_workos_user_id_format_check', sql`${t.workosUserId} ~ '^user_[0-9A-Za-z]+$'`),
  ],
);

/**
 * Sessions issued by xecret, not by the identity provider. WorkOS is consulted
 * once, at sign-in, and the tokens it issues are discarded unread (ADR 0010).
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
    /**
     * How the sign-in that issued this session authenticated — the audit log's
     * closed set. `NULL` on every session issued before migration 0022, which
     * the organisation resolution reads as "not single sign-on".
     */
    signInMethod: text('sign_in_method').$type<SignInMethod>(),
    /**
     * The WorkOS organisation whose single sign-on issued this session, or
     * `NULL`. What `sso_required` is checked against on every request
     * (`resolveOrg`): a non-owner member of an organisation that requires SSO
     * reaches it only through a session whose value here is that
     * organisation's `workos_org_id`. Set only beside `sso`.
     */
    ssoWorkosOrgId: text('sso_workos_org_id'),
    /**
     * The AuthKit session the issuing sign-in came from — the `sid` claim of
     * the code exchange's access token — or `NULL` (migration 0023). Sign-out
     * answers with WorkOS's logout URL for it, so leaving xecret ends the
     * AuthKit session too and the next sign-in is asked for, not reused.
     */
    workosSessionId: text('workos_session_id'),
    /**
     * When the person actively authenticated for the re-authentication that
     * issued this session (WorkOS's `auth_time`, during the flow), by any
     * method that re-proves who they are; `NULL` for every other session
     * (migration 0023). What the SSO setup portal's step-up reads.
     */
    freshAuthAt: timestamp('fresh_auth_at', { withTimezone: true }),
  },
  (t) => [
    // Hot path: every authenticated request resolves the actor through this.
    index('sessions_lookup_idx')
      .on(t.tokenHash)
      .where(sql`${t.revokedAt} is null`),
    // Powers the "active devices" list and "sign out everywhere".
    index('sessions_user_idx').on(t.userId, t.createdAt.desc()),
    check('sessions_sign_in_method_check', signInMethodCheck(t.signInMethod)),
    check(
      'sessions_sso_org_needs_sso_check',
      sql`${t.ssoWorkosOrgId} is null or ${t.signInMethod} = 'sso'`,
    ),
    check(
      'sessions_workos_session_id_check',
      sql`${t.workosSessionId} is null or ${t.workosSessionId} ~ '^session_[0-9A-Za-z]{1,64}$'`,
    ),
  ],
);

/**
 * The closed set a `sign_in_method` column may hold — restated from
 * `SignInMethod` because a CHECK cannot import a type. Migration 0022 writes
 * the same list; a method added to the audit vocabulary needs a migration here.
 */
export function signInMethodCheck(column: AnyPgColumn) {
  return sql`${column} is null or ${column} in ('password', 'oauth', 'sso', 'magic_auth', 'passkey', 'other')`;
}

/**
 * A sign-in confirmation that has been spent — continued or cancelled — by
 * the SHA-256 of the nonce its sealed cookie carried (migration 0022). The
 * primary key is the single-use guarantee: a second use of the same cookie
 * collides with it.
 */
export const signInConfirmations = pgTable(
  'sign_in_confirmations',
  {
    nonceHash: bytea('nonce_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    spentAt: timestamp('spent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sign_in_confirmations_nonce_hash_length_check', sql`octet_length(${t.nonceHash}) = 32`),
  ],
);
