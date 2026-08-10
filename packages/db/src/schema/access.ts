import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accessLevelEnum } from './enums';
import { environments, projects } from './resources';
import { orgMembers } from './tenancy';
import { users } from './identity';

/**
 * Per-member overrides on top of the role default.
 *
 * Resolution order — most specific wins, and an explicit `none` always denies:
 *   1. grant for (member, project, environment)   ← most specific
 *   2. grant for (member, project, NULL)          ← whole project
 *   3. role default from org_members.role
 *
 * Production is deny-by-default even for the `developer` role. Granting it is a
 * conscious act that appears in the audit log.
 */
export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey(),
    orgMemberId: uuid('org_member_id')
      .notNull()
      .references(() => orgMembers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** NULL means the grant covers the whole project. */
    environmentId: uuid('environment_id').references(() => environments.id, {
      onDelete: 'cascade',
    }),
    accessLevel: accessLevelEnum('access_level').notNull(),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // COALESCE is required: PostgreSQL treats NULLs as distinct, so a plain
    // UNIQUE would permit duplicate project-wide grants for the same member.
    uniqueIndex('access_grants_unique_idx').on(
      t.orgMemberId,
      t.projectId,
      sql`coalesce(${t.environmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index('access_grants_member_idx').on(t.orgMemberId),
  ],
);
