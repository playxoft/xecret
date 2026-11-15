import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * xecret's own staff — the people who may open the admin page (`/app/admin`)
 * and hand out complimentary plans and promo codes (migration 0035).
 *
 * ── Why a row per account, not an address ──
 * An address is what somebody types; an account is who signed in. Keyed by
 * the account, a row means exactly that person, and an account deleted takes
 * its row with it — no address left behind for whoever claims it next.
 *
 * ── Who writes these ──
 * Another admin, from the admin page — never removing the last one — or an
 * operator with database credentials (`npm run admin`), which is how the first
 * one exists at all. Rows are added and removed, never edited: the role holds
 * no UPDATE on either table, and the history only grows.
 */
export const platformAdmins = pgTable('platform_admins', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The admin who added this one; `null` for an operator at a shell, or one since deleted. */
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const PLATFORM_ADMIN_ACTIONS = ['added', 'removed'] as const;
export type PlatformAdminAction = (typeof PLATFORM_ADMIN_ACTIONS)[number];

/**
 * Every admin added or removed: who, by whom, when. The address is a copy taken
 * at the time, so the record still reads once the account is gone. Internal —
 * never shown to a customer. Append-only by grant.
 */
export const platformAdminChanges = pgTable(
  'platform_admin_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action').notNull().$type<PlatformAdminAction>(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    /** The admin who made the change, or `null` with `byLabel` set — an operator at a shell. */
    byUserId: uuid('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    byLabel: text('by_label'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('platform_admin_changes_action_check', sql`${t.action} in ('added', 'removed')`),
    check('platform_admin_changes_email_check', sql`length(${t.email}) between 3 and 320`),
    check(
      'platform_admin_changes_by_label_check',
      sql`${t.byLabel} is null or length(${t.byLabel}) between 1 and 128`,
    ),
    check(
      'platform_admin_changes_by_check',
      sql`${t.byUserId} is not null or ${t.byLabel} is not null`,
    ),
    index('platform_admin_changes_at_idx').on(t.at),
  ],
);
