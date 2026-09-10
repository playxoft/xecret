import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext } from './columns';
import { organizations } from './tenancy';
import { users } from './identity';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: citext('slug').notNull(),
    description: text('description'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Partial, so a soft-deleted project's slug becomes available again.
    uniqueIndex('projects_org_slug_idx')
      .on(t.orgId, t.slug)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: citext('slug').notNull(),
    /**
     * A first-class column rather than a slug convention, so production
     * safeguards work correctly for an environment named `prod-eu-west`:
     * stronger permission checks, destructive-action confirmation, distinct UI.
     */
    isProduction: boolean('is_production').notNull().default(false),
    /**
     * Which key hierarchy this environment's values are encrypted under.
     *
     *  - `server` — the envelope of ADR 0001: `org_keys` wraps `env_keys`, the
     *    Worker unwraps both and holds plaintext for the length of a request.
     *  - `e2ee` — the hierarchy of ADR 0009: an `env_data_keys` row the server
     *    has never held the bytes of, sealed to each principal in
     *    `env_key_grants`. The Worker stores and returns ciphertext and can
     *    decrypt none of it.
     *
     * **A migration mechanism, not a product option.** Nothing in the API lets a
     * caller choose: every environment created from Phase 3 onward is `e2ee`,
     * which is why the default is `e2ee` here while migration 0013 backfills
     * every existing row to `server`. A row moves from `server` to `e2ee` exactly
     * once, by the Phase 5 migration ceremony, and never back once the old
     * ciphertext is gone.
     *
     * Text with a CHECK rather than a `pgEnum`, for the reason
     * `user_key_wraps.kind` gives: the set is pinned by an ADR and closes when
     * the migration completes, so it will shrink to one value and then vanish —
     * the opposite of the open-ended growth an enum advertises.
     */
    encryptionMode: text('encryption_mode').notNull().default('e2ee'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('environments_encryption_mode_check', sql`${t.encryptionMode} in ('server', 'e2ee')`),
    uniqueIndex('environments_project_slug_idx')
      .on(t.projectId, t.slug)
      .where(sql`${t.deletedAt} is null`),
  ],
);
