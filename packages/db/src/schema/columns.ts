import { customType } from 'drizzle-orm/pg-core';

/**
 * Custom column types shared across the schema.
 * See docs/architecture/database-schema.md for the rationale behind each.
 */

/**
 * Ciphertext, IVs, and token hashes. Always `bytea` — never `text`, and never
 * base64 in the database. Base64 round-tripping wastes 33% of every row and
 * invites accidental logging of what looks like a harmless string.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

/**
 * Case-insensitive text, for emails and slugs.
 * Requires `CREATE EXTENSION citext` — see migration 0000.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** IP addresses in audit and token-usage records. */
export const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

/** `inet[]`, for service-token IP allowlists. */
export const inetArray = customType<{ data: string[] }>({
  dataType() {
    return 'inet[]';
  },
});
