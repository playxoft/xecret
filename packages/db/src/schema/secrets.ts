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
import { envDataKeys } from './env-keys';
import { envKeys } from './keys';
import { environments } from './resources';
import { users } from './identity';
import { serviceTokens } from './tokens';

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * Non-sensitive description shown in the UI. Never holds a value.
     *
     * **`server`-mode environments only.** An `e2ee` environment writes
     * `enc_note` instead and leaves this NULL, because a note is free text a
     * person types beside a credential and people put credentials in it — the
     * column's comment has always said "never holds a value" and has never been
     * able to enforce it. Under ADR 0009 the honest answer is to stop reading it.
     */
    note: text('note'),
    /**
     * `xk2.gcm.` blob (spec §2.2, type 10): the note, encrypted under the EDK.
     *
     * On `secrets` rather than on `secret_versions`, and therefore bound by an
     * AAD carrying no version (spec §4.2) — a note is a label on the secret, not
     * a property of one of its values, and binding a version that does not exist
     * would be a fabricated component the two implementations would eventually
     * disagree about.
     *
     * Nullable in both directions: a `server`-mode row never has one, and an
     * `e2ee` secret with no note has none either. There is no CHECK pairing this
     * with `note`, because the rule depends on `environments.encryption_mode`,
     * which is two joins away and unreachable from a row constraint. The
     * application decides, and `secrets-service.ts` is where it decides.
     */
    encNote: bytea('enc_note'),
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
    /**
     * Exactly one of these two is set — `secrets_writer_check` enforces it.
     * A person's write names the person; a CI write names the token. Neither
     * column may stand in for the other: attributing a CI write to whoever
     * minted the token would put a name on a write they did not make (see
     * docs/architecture/api.md §2).
     */
    createdBy: uuid('created_by').references(() => users.id),
    createdByServiceTokenId: uuid('created_by_service_token_id').references(() => serviceTokens.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'secrets_writer_check',
      sql`num_nonnulls(${t.createdBy}, ${t.createdByServiceTokenId}) = 1`,
    ),
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
    /**
     * The encrypted value. What the bytes *are* depends on which key column is
     * set, and the two are not interchangeable:
     *
     *  - `server` mode — raw AES-256-GCM ciphertext with its tag appended, whose
     *    IV is the separate `iv` column.
     *  - `e2ee` mode — the **ASCII bytes of an `xk2.gcm.` blob** (spec §2.2, type
     *    9), which carries its own IV inside the base64url payload. There is no
     *    `iv` column value at all, because the format does not put one there.
     */
    ciphertext: bytea('ciphertext').notNull(),
    /**
     * 96-bit, unique per encryption. Reuse breaks AES-GCM entirely.
     *
     * `server` mode only, and NULL for every `e2ee` row — not because an e2ee
     * value has no IV, but because the spec puts it *inside* the blob, where it
     * travels with the ciphertext it belongs to and cannot be paired with the
     * wrong one. `secret_versions_server_iv_check` ties the column to the mode in
     * both directions, so a server-envelope row still cannot be written without
     * one; that invariant is unchanged, only narrowed to the rows it applies to.
     */
    iv: bytea('iv'),
    /**
     * The `env_keys` row this value was encrypted under. `server` mode only.
     *
     * Nullable as of ADR 0009, where it once was not: an `e2ee` value is
     * encrypted under an `env_data_keys` row instead, and pointing it at a server
     * envelope key would claim the Worker can open it.
     */
    envKeyId: uuid('env_key_id').references(() => envKeys.id, { onDelete: 'restrict' }),
    /**
     * The `env_data_keys` row this value was encrypted under. `e2ee` mode only.
     *
     * `restrict`, like every other key reference in this schema: an EDK row must
     * never disappear as a side effect of deleting something else, because the
     * values written under it stay encrypted under it forever. A rotation retires
     * the row; it does not delete it, and this is the constraint that makes that
     * a rule rather than a habit.
     */
    envDataKeyId: uuid('env_data_key_id').references(() => envDataKeys.id, {
      onDelete: 'restrict',
    }),
    /**
     * The cipher, as named by the server envelope. `server` mode carries the
     * construction it used; an `e2ee` row's real algorithm tag lives inside its
     * blob prefix, and `client_algorithm` records what the client said it was.
     */
    algorithm: text('algorithm').notNull().default('AES-256-GCM'),
    /**
     * What the *client* says it encrypted with, e.g. `xk2.gcm`. `e2ee` mode only.
     *
     * Stored verbatim and never parsed here. It exists so an operator can answer
     * "which construction wrote this row" without decoding a blob, and so a
     * future format change is queryable rather than archaeological. The server
     * draws no conclusion from it: the blob's own prefix is what a client parses,
     * and a disagreement between the two is a client bug that fails closed at
     * decryption.
     */
    clientAlgorithm: text('client_algorithm'),
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
    /** Same exactly-one pairing as `secrets` — see the comment there. */
    createdBy: uuid('created_by').references(() => users.id),
    createdByServiceTokenId: uuid('created_by_service_token_id').references(() => serviceTokens.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'secret_versions_writer_check',
      sql`num_nonnulls(${t.createdBy}, ${t.createdByServiceTokenId}) = 1`,
    ),
    /**
     * **Exactly one key, and therefore exactly one mode, per row.**
     *
     * The constraint that makes the dual-mode period safe. A row naming both
     * keys claims two different sets of bytes decrypt it; a row naming neither is
     * ciphertext nothing can ever open, and — worse — would read as an `e2ee` row
     * to any query that tests `env_key_id IS NULL`. Both are silent, permanent
     * data loss, so the database refuses them rather than the application
     * remembering to.
     *
     * The same `num_nonnulls` shape as `secret_versions_writer_check` directly
     * above, on purpose: this schema has one way of saying "exactly one of these".
     */
    check('secret_versions_key_check', sql`num_nonnulls(${t.envKeyId}, ${t.envDataKeyId}) = 1`),
    // A server-envelope row has an IV and an e2ee row does not, in both
    // directions. The forward half preserves the original NOT NULL exactly where
    // it meant something; the reverse half stops a stray IV column being written
    // beside a blob that already contains one, where it could only ever be used
    // by mistake.
    check(
      'secret_versions_server_iv_check',
      sql`(${t.envKeyId} is not null) = (${t.iv} is not null)`,
    ),
    // Likewise for the client's algorithm tag: it belongs to an e2ee row and to
    // nothing else, so a `server` row cannot claim a client construction.
    check(
      'secret_versions_client_algorithm_check',
      sql`(${t.envDataKeyId} is not null) = (${t.clientAlgorithm} is not null)`,
    ),
    unique('secret_versions_secret_version_unique').on(t.secretId, t.version),
    // Resolves "current value" and drives the bulk read path used by `xecret run`.
    index('secret_versions_current_idx').on(t.secretId, t.version.desc()),
  ],
);
