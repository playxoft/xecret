import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, inet, inetArray } from './columns';
import { accessLevelEnum } from './enums';
import { environments, projects } from './resources';
import { organizations } from './tenancy';
import { users } from './identity';

/**
 * CLI and CI credentials live in two separate tables rather than one table with
 * a nullable `user_id`.
 *
 * They have genuinely different lifecycles and blast radii, and a CI token must
 * never be able to act as a person (threat T5). Separate tables make that
 * impossible by construction rather than merely discouraged.
 */

export const cliTokens = pgTable(
  'cli_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Device name, e.g. "Nitheesh's MacBook Pro" — shown in the revoke UI. */
    name: text('name').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    /** e.g. "xct_live_a1b2" — for identification in the UI. Never usable. */
    tokenPrefix: text('token_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: inet('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('cli_tokens_lookup_idx')
      .on(t.tokenHash)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const serviceTokens = pgTable(
  'service_tokens',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * NOT NULL by design. A CI token is always scoped to exactly one
     * environment — the primary blast-radius control for a compromised pipeline.
     */
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    accessLevel: accessLevelEnum('access_level').notNull().default('read'),
    ipAllowlist: inetArray('ip_allowlist'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: inet('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('service_tokens_lookup_idx')
      .on(t.tokenHash)
      .where(sql`${t.revokedAt} is null`),
    index('service_tokens_env_idx').on(t.environmentId),
  ],
);
