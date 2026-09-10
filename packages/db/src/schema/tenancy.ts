import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AccessLevel } from '@xecret/core/authz';
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
  (t) => [
    check('organizations_seat_limit_check', sql`${t.seatLimit} >= 0`),
    // Read on every organisation creation, inside the transaction that creates
    // one: `countOrganizationsHeldBy` asks how many live organisations this
    // account created and is still in. The column order is the query's —
    // equality on `created_by`, then `id` to supply the ordering — so its
    // `LIMIT` can stop after the ceiling's worth of rows instead of finding
    // every organisation the account ever created and sorting the lot. Left
    // ascending: the query wants `id desc`, and a btree is read backwards for
    // that at no cost. Partial, because the count never looks at a soft-deleted
    // row. The membership half of the join is already served by
    // `org_members_org_user_unique`.
    index('organizations_creator_idx')
      .on(t.createdBy, t.id)
      .where(sql`${t.deletedAt} is null`),
  ],
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

/**
 * One selection in an invitation's `initial_grants` snapshot.
 * `environmentId: null` selects the whole project.
 */
export interface InvitationGrantSeed {
  projectId: string;
  environmentId: string | null;
  /**
   * The level to write at acceptance. Absent — which every seed written
   * before the invite dialog offered levels is — falls back to the invited
   * role's ordinary (non-production) default, exactly as it always did.
   *
   * Optional rather than a column default because this is a jsonb snapshot:
   * old rows keep their old shape, and the reader is the only place that has
   * to know both. `'none'` is representable and meaningful — an explicit
   * denial written at acceptance.
   */
  accessLevel?: AccessLevel;
}

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
    /**
     * The access the inviter selected, applied when the invitation is accepted.
     *
     * `NULL` means the invitation predates selection and acceptance behaves as
     * it always did: role defaults everywhere. Non-null — an empty array
     * included — switches acceptance to **deny-by-default**: every project the
     * organisation has at acceptance time receives an explicit `none` grant
     * unless it appears here, and each listed environment receives a grant at
     * the level the seed names, or at the invited role's non-production level
     * when it names none.
     *
     * A snapshot in jsonb rather than a relational table on purpose: these
     * rows are a *request in transit*, not live authority. Authority only
     * exists once acceptance copies them into `access_grants`, which is where
     * the relational modelling, the uniqueness rules and the audit live.
     * Entries are ids, not slugs — a rename must not re-address a grant — and
     * anything that no longer exists at acceptance is simply skipped.
     */
    initialGrants: jsonb('initial_grants').$type<InvitationGrantSeed[] | null>(),
    /**
     * The invitation's X25519 **public** key, 32 raw bytes (spec §10).
     *
     * The inviter's client generates a 16-byte fragment, derives a keypair from
     * it, seals the relevant EDK and EHK grants to this public key, and uploads
     * the public half here. The fragment itself **never reaches the server** —
     * it travels to the invitee out of band, over a different channel from the
     * emailed `xin_…` token, which is the whole of the two-channel design: a
     * leaked email decrypts nothing, and a leaked fragment authenticates nothing.
     *
     * Nullable, because an invitation into an organisation whose environments are
     * all `server`-mode carries no grants and needs no keypair.
     */
    invitePublicKey: bytea('invite_public_key'),
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
