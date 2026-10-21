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
  uuid,
} from 'drizzle-orm/pg-core';
import type { SecretPolicy } from '@xecret/core/policy';
import { bytea, inet } from './columns';
import { users } from './identity';
import { environments } from './resources';
import { organizations } from './tenancy';

/**
 * The tables P19 adds (migrations 0029–0032). Each is documented at length in
 * its migration; what is here is the shape the code reads.
 */

/**
 * A personal override (P19 §2): a value under its owner's own override key
 * (spec §2.2 type 13). Served to its owner, through a person's credential,
 * and never to a service token.
 */
export const personalOverrides = pgTable(
  'personal_overrides',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The ASCII of an `xk2.gcm.` blob. Stored verbatim; the server holds no key for it. */
    ciphertext: bytea('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('personal_overrides_owner_name_unique').on(t.environmentId, t.userId, t.name),
    check('personal_overrides_name_check', sql`${t.name} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
    index('personal_overrides_user_idx').on(t.userId, t.orgId),
  ],
);

/** A webhook endpoint (P19 §5). Its signing secret is sealed under the org master key. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description'),
    eventTypes: text('event_types').array().notNull(),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretIv: bytea('secret_iv').notNull(),
    secretKeyVersion: integer('secret_key_version').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    disabledReason: text('disabled_reason').$type<'manual' | 'failures'>(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failingSince: timestamp('failing_since', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('webhooks_events_check', sql`cardinality(${t.eventTypes}) >= 1`),
    check(
      'webhooks_disabled_reason_check',
      sql`${t.disabledReason} is null or ${t.disabledReason} in ('manual', 'failures')`,
    ),
    check('webhooks_enabled_reason_check', sql`${t.enabled} = (${t.disabledReason} is null)`),
    check('webhooks_failures_check', sql`${t.consecutiveFailures} >= 0`),
    index('webhooks_org_idx').on(t.orgId),
  ],
);

export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'abandoned';

/** One delivery of one event to one endpoint, with its retries. Its id is the `webhook-id`. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'webhook_deliveries_status_check',
      sql`${t.status} in ('pending', 'delivering', 'succeeded', 'abandoned')`,
    ),
    check('webhook_deliveries_attempts_check', sql`${t.attempts} >= 0`),
    // Per organisation, because the sweep takes organisations in turns.
    index('webhook_deliveries_due_idx')
      .on(t.orgId, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_claimed_idx')
      .on(t.claimedAt)
      .where(sql`${t.status} = 'delivering'`),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt.desc()),
  ],
);

/** An organisation's token and secret policies (P19 §6, §8). No row is every default. */
export const orgPolicies = pgTable(
  'org_policies',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tokenRequireIpAllowlist: boolean('token_require_ip_allowlist').notNull().default(false),
    tokenMaxLifetimeDays: integer('token_max_lifetime_days'),
    secretPolicy: jsonb('secret_policy').$type<SecretPolicy>(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'org_policies_token_lifetime_check',
      sql`${t.tokenMaxLifetimeDays} is null or ${t.tokenMaxLifetimeDays} between 1 and 3650`,
    ),
    check(
      'org_policies_secret_policy_object_check',
      sql`${t.secretPolicy} is null or jsonb_typeof(${t.secretPolicy}) = 'object'`,
    ),
  ],
);

export type SightingPrincipalKind = 'user' | 'cli_token' | 'service_token';

/** Which addresses and devices have read an environment (P19 §7). */
export const environmentReadSightings = pgTable(
  'environment_read_sightings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    principalKind: text('principal_kind').$type<SightingPrincipalKind>().notNull(),
    principalId: uuid('principal_id').notNull(),
    principalLabel: text('principal_label'),
    ipAddress: inet('ip_address').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [
    unique('environment_read_sightings_unique').on(
      t.environmentId,
      t.principalKind,
      t.principalId,
      t.ipAddress,
    ),
    check(
      'environment_read_sightings_kind_check',
      sql`${t.principalKind} in ('user', 'cli_token', 'service_token')`,
    ),
    index('environment_read_sightings_owed_idx')
      .on(t.orgId, t.firstSeenAt)
      .where(sql`${t.notifiedAt} is null`),
  ],
);

/** When each organisation was last sent a read-alert digest — the throttle. */
export const readAlertDigests = pgTable('read_alert_digests', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
});
