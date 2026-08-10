import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('environments_project_slug_idx')
      .on(t.projectId, t.slug)
      .where(sql`${t.deletedAt} is null`),
  ],
);
