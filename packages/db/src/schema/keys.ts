import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './columns';
import { keyStatusEnum } from './enums';
import { environments } from './resources';
import { organizations } from './tenancy';

/**
 * The envelope-encryption key hierarchy.
 * See docs/adr/0002-root-key-custody.md and docs/security/key-recovery.md.
 *
 *   Root KEK (never in this database)
 *     └─ wraps → org_keys.wrapped_key
 *          └─ wraps → env_keys.wrapped_key
 *               └─ encrypts → secret_versions.ciphertext
 *
 * `onDelete: 'restrict'` on both tables is deliberate: a key row must never
 * disappear as a side effect of deleting something else, because that would
 * orphan ciphertext permanently and irrecoverably.
 */

export const orgKeys = pgTable(
  'org_keys',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    /** Org Master Key, wrapped by the Root KEK. */
    wrappedKey: bytea('wrapped_key').notNull(),
    /** 96-bit IV used for the wrap operation. */
    wrapIv: bytea('wrap_iv').notNull(),
    /** Which Root KEK version wrapped this. Makes root rotation a re-wrap. */
    rootKeyVersion: integer('root_key_version').notNull(),
    algorithm: text('algorithm').notNull().default('AES-256-GCM'),
    status: keyStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    unique('org_keys_org_version_unique').on(t.orgId, t.version),
    index('org_keys_active_idx')
      .on(t.orgId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const envKeys = pgTable(
  'env_keys',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'restrict' }),
    orgKeyId: uuid('org_key_id')
      .notNull()
      .references(() => orgKeys.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    /** Env Data Key, wrapped by the Org Master Key. */
    wrappedKey: bytea('wrapped_key').notNull(),
    wrapIv: bytea('wrap_iv').notNull(),
    algorithm: text('algorithm').notNull().default('AES-256-GCM'),
    status: keyStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    unique('env_keys_environment_version_unique').on(t.environmentId, t.version),
    index('env_keys_active_idx')
      .on(t.environmentId)
      .where(sql`${t.status} = 'active'`),
  ],
);
