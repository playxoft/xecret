import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AuditMetadata } from '@xecret/core/audit';
import { inet } from './columns';
import { actorTypeEnum, auditOutcomeEnum } from './enums';

/**
 * Append-only audit log, range-partitioned by month.
 *
 * Design notes (full rationale in docs/architecture/database-schema.md §8):
 *
 * - **No foreign keys.** Audit records must outlive the rows they reference. A
 *   deleted project must not erase the record that it existed and who deleted it.
 * - **`actorLabel` is denormalised** for the same reason: the log must still read
 *   "nitheesh@playxoft.com deleted DATABASE_URL" after that user is gone.
 * - **Partitioning** is applied by hand-written SQL in the migration; Drizzle
 *   cannot express `PARTITION BY RANGE`. `created_at` is therefore part of the
 *   primary key, as PostgreSQL requires the partition key there.
 * - **Append-only is enforced by database grants**, not convention: the
 *   application role has INSERT and SELECT here, and no UPDATE or DELETE.
 * - **`metadata` can never hold a secret value** — its type is `AuditMetadata`
 *   from @xecret/core, an allowlist of field names with no index signature.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').notNull(),
    orgId: uuid('org_id').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    projectId: uuid('project_id'),
    environmentId: uuid('environment_id'),
    outcome: auditOutcomeEnum('outcome').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<AuditMetadata>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('audit_logs_org_time_idx').on(t.orgId, t.createdAt.desc()),
    index('audit_logs_actor_idx').on(t.orgId, t.actorId, t.createdAt.desc()),
    index('audit_logs_action_idx').on(t.orgId, t.action, t.createdAt.desc()),
    index('audit_logs_environment_idx').on(t.environmentId, t.createdAt.desc()),
  ],
);
