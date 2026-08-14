import { sql } from 'drizzle-orm';
import {
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
import { bytea } from './columns';
import { envKeys } from './keys';
import { environments } from './resources';
import { users } from './identity';

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Non-sensitive description shown in the UI. Never holds a value. */
    note: text('note'),
    /**
     * What shape the value is expected to have — see `SECRET_VALUE_TYPES` in
     * `@xecret/core/validation`.
     *
     * A property of the *secret*, not of a version: `PORT` is an integer in
     * every version it will ever have, and hanging the type off the version row
     * would let v4 be an integer while v5 is a URL, which is not a rotation but
     * a different secret wearing the same name.
     *
     * `string` is the default and accepts anything, so every row that predates
     * this column is already correct rather than merely tolerated.
     */
    valueType: text('value_type').notNull().default('string'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Mirrors packages/core/validation/secret-name.ts. Both halves exist on
    // purpose: the application gives a good error message, the database
    // guarantees the invariant even if a query bypasses the application layer.
    check('secrets_name_check', sql`${t.name} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
    // Mirrors `SECRET_VALUE_TYPES`. A CHECK rather than a PostgreSQL enum: this
    // list will grow, and adding a value to an enum is a migration that has to
    // run before any deployment can write the new value, whereas widening a
    // CHECK is not. Deliberately kept in sync by hand — `schema.test.ts` fails
    // if the two lists diverge, so the pairing is enforced rather than hoped for.
    check(
      'secrets_value_type_check',
      sql`${t.valueType} in ('string','boolean','int','decimal','email','url','date','datetime','json','yaml','xml','ulid','uuidv4','uuidv7')`,
    ),
    uniqueIndex('secrets_env_name_idx')
      .on(t.environmentId, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * APPEND-ONLY. Updating a secret inserts a new row; it never mutates an existing
 * one. This gives rotation, rollback, and audit history for free. The current
 * value is the row with the highest `version`.
 */
export const secretVersions = pgTable(
  'secret_versions',
  {
    id: uuid('id').primaryKey(),
    secretId: uuid('secret_id')
      .notNull()
      .references(() => secrets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    /** 96-bit, unique per encryption. Reuse breaks AES-GCM entirely. */
    iv: bytea('iv').notNull(),
    envKeyId: uuid('env_key_id')
      .notNull()
      .references(() => envKeys.id, { onDelete: 'restrict' }),
    algorithm: text('algorithm').notNull().default('AES-256-GCM'),
    /**
     * An HMAC, deliberately not a plain hash.
     *
     * Lets a write detect "the value did not actually change" without
     * decrypting. A SHA-256 of the plaintext would be a brute-force oracle:
     * most secrets are low-entropy enough (short API keys, connection strings)
     * that an attacker holding the database could confirm guesses offline. The
     * HMAC key is derived from the environment's data key via HKDF, so this
     * value is useless without the key hierarchy.
     */
    valueHmac: bytea('value_hmac'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('secret_versions_secret_version_unique').on(t.secretId, t.version),
    // Resolves "current value" and drives the bulk read path used by `xecret run`.
    index('secret_versions_current_idx').on(t.secretId, t.version.desc()),
  ],
);
