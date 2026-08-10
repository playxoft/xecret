import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, citext } from './columns';
import { memberStatusEnum, orgRoleEnum } from './enums';
import { users } from './identity';

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: citext('slug').notNull().unique(),
    // Billing is not implemented in v1 (ADR: see plan §"Deliberately NOT in v1").
    // This column is the only hook it needs, so adding billing later is additive.
    seatLimit: integer('seat_limit').notNull().default(5),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [check('organizations_seat_limit_check', sql`${t.seatLimit} >= 0`)],
);

/**
 * The table every authorization query passes through.
 *
 * INVARIANT, enforced in application code and tested explicitly: an
 * organisation always retains at least one active `owner`. Removing or demoting
 * the last owner is rejected.
 */
export const orgMembers = pgTable(
  'org_members',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull(),
    status: memberStatusEnum('status').notNull().default('active'),
    seatAssigned: boolean('seat_assigned').notNull().default(true),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('org_members_org_user_unique').on(t.orgId, t.userId),
    // The single most performance-critical index in the schema: authorization
    // resolves through it on every request.
    index('org_members_user_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index('org_members_org_idx')
      .on(t.orgId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: orgRoleEnum('role').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Blocks invitation spam to one address while still permitting re-invitation
    // after the previous invitation expires or is revoked.
    uniqueIndex('invitations_pending_idx')
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);
