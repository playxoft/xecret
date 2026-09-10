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
import { users } from './identity';
import { environments } from './resources';
import { invitations } from './tenancy';
import { serviceTokens } from './tokens';

/**
 * The sharing half of the zero-knowledge hierarchy: per-environment keys, and
 * the sealed grants that hand them to principals.
 *
 * See docs/adr/0009-zero-knowledge-encryption.md and the byte-level definitions
 * in docs/security/e2ee-crypto-spec.md, which is normative for everything here.
 *
 *   Environment Data Key (EDK, 32B)   → env_data_keys       [never stored raw]
 *   Environment HMAC Key (EHK, 32B)   → env_hmac_keys       [never stored raw]
 *        │
 *        ├─ sealed to a member's X25519 public key  ─┐
 *        ├─ sealed to a service token's public key  ─┼→ env_key_grants
 *        └─ sealed to an invitation's public key    ─┘   (+ Ed25519 signature)
 *
 * ── The property to check every future column against ──
 * **`env_data_keys` and `env_hmac_keys` hold no key material at all.** They are
 * *identity and version* rows: an id, which environment, which version, who
 * created it, when. The bytes themselves exist only inside `env_key_grants`,
 * sealed to a public key whose private half this server has never seen. There is
 * no column here, and no combination of columns, from which a server — or anyone
 * holding a full dump plus every server-side secret — can produce an EDK or an
 * EHK. Adding one would end the claim ADR 0009 makes.
 *
 * That is why these tables look so thin beside `env_keys`, the server envelope
 * they replace: `env_keys.wrapped_key` is a key this deployment can unwrap, and
 * the whole point of the migration is that its successor is not.
 *
 * ── How binary columns are used ──
 * Every `bytea` in `env_key_grants` holds the **ASCII bytes of an `xk2.…` blob**
 * (spec §2), not raw ciphertext — the same convention `vault.ts` documents. The
 * version prefix travels with the value, so a row written by a future format
 * fails to parse rather than being misread as this one, and `bytea` rather than
 * `text` keeps every ciphertext column in this schema one type.
 *
 * The server never parses any of it. It validates length and prefix at the API
 * boundary and stores what it is given.
 */

/**
 * One Environment Data Key, by version.
 *
 * A new row per rotation, and rotation is what happens when a principal loses
 * access: the client generates fresh key bytes, re-seals them to everyone who
 * remains, and the old row is marked `retired`. Retired rows are kept because
 * historical `secret_versions` still reference them — the values written under
 * version 3 are still encrypted under version 3, and deleting the row would
 * orphan them (which is why the FK from `secret_versions` is `restrict`).
 *
 * `status` reuses `key_status` in name only; it is a text column with a CHECK
 * rather than the `keyStatusEnum` the server envelope uses, because this set is
 * pinned by ADR 0009 and not by an operational vocabulary that may grow.
 */
export const envDataKeys = pgTable(
  'env_data_keys',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'restrict' }),
    /** Increments on every rotation. Interpolated into every grant's AAD (spec §4.2). */
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'),
    /**
     * The member whose unlocked client generated these key bytes.
     *
     * Not `onDelete: 'cascade'`: the row records *who created a key version*,
     * and that fact outlives the account. `users` is soft-deleted anyway, so the
     * reference stays resolvable.
     */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('env_data_keys_status_check', sql`${t.status} in ('active', 'retired')`),
    check('env_data_keys_version_check', sql`${t.version} >= 1`),
    // A version number names one key, forever. Grants bind `edkVersion` into
    // their AAD, so two rows sharing one would be two keys one grant claims to
    // open.
    unique('env_data_keys_environment_version_unique').on(t.environmentId, t.version),
    /**
     * **Exactly one active EDK per environment.**
     *
     * The load-bearing constraint of this table, and partial for the same reason
     * `user_key_wraps_passphrase_unique` is: the retired history is unbounded
     * while the present is unique. Two active rows would mean two answers to
     * "which key does the next write use", and a client that picked the older
     * one would encrypt under a key a revoked principal still holds — silently
     * undoing the rotation that retired it.
     */
    uniqueIndex('env_data_keys_active_unique')
      .on(t.environmentId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * One Environment HMAC Key per environment. Never versioned.
 *
 * The EHK exists for exactly one reason: `valueHmac` must stay stable across an
 * EDK rotation, so that the first write to every secret after a rotation is not
 * recorded as a change when nothing changed (spec §9). Keying it from the EDK
 * would tie it to the thing that rotates and lose that property, which is why
 * this is a separate key rather than an HKDF branch of the other one.
 *
 * `environment_id` is unique rather than merely indexed: an environment with two
 * HMAC keys is an environment where two clients disagree about whether a value
 * changed. If an org ever elects to rotate one, that is a delete-and-recreate
 * ceremony accepting one round of spurious "changed" detections — not a version
 * bump, and not a second row (ADR 0009, trade-off 4).
 */
export const envHmacKeys = pgTable(
  'env_hmac_keys',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .unique('env_hmac_keys_environment_unique')
      .references(() => environments.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('env_hmac_keys_environment_idx').on(t.environmentId)],
);

/** The three kinds of principal a grant can address. Matches spec §4.1. */
export const GRANT_RECIPIENT_KINDS = ['member', 'token', 'invite'] as const;

export type GrantRecipientKind = (typeof GRANT_RECIPIENT_KINDS)[number];

/**
 * One principal's copy of an environment's keys: the EDK and the EHK, each
 * sealed to that principal's X25519 public key, signed by whoever sealed them.
 *
 * ── Exactly one principal, enforced by CHECK ──
 * Three nullable foreign keys and `num_nonnulls(...) = 1`, following the
 * `secrets_writer_check` precedent rather than inventing a discriminator column
 * beside them. A `kind` column plus three nullable ids would let the two
 * disagree — a row labelled `member` carrying a `service_token_id` — and the
 * label is what goes into the AAD, so a disagreement there is a grant that
 * cannot be opened by the principal it names. Deriving the kind from which
 * column is set makes that unrepresentable.
 *
 * ── Two sealed blobs, not one ──
 * `edk_sealed` and `ehk_sealed` are the same construction to the same public key
 * with different AAD and different plaintext (spec §2.2, types 6 and 7). They
 * are separate columns because the EHK is re-sealed *unchanged* across an EDK
 * rotation while the EDK is replaced: one column holding a pair would mean
 * re-sealing a key that did not change, every rotation, for no reason.
 *
 * ── The signature is NOT NULL ──
 * Every row created by this code path is signed by its creator at creation
 * (spec §6). Verification is deferred past v1 — it needs a trust root for signer
 * keys — but the columns are not, because enabling verification later must be a
 * client update rather than a data migration over grants that never carried one.
 * A nullable signature would guarantee exactly the migration it was meant to
 * avoid. There are no legacy rows: this table is created with the constraint.
 */
export const envKeyGrants = pgTable(
  'env_key_grants',
  {
    id: uuid('id').primaryKey(),
    envDataKeyId: uuid('env_data_key_id')
      .notNull()
      .references(() => envDataKeys.id, { onDelete: 'cascade' }),

    /**
     * The three principals, exactly one of which is set.
     *
     * All three cascade, and each for its own reason. A deleted user's grants
     * are sealed to a public key that no longer exists; a revoked token's are
     * sealed to a private key that only ever lived inside the token string; an
     * invitation's are consumed and deleted at acceptance, when the invitee
     * re-seals them to their own key. In every case the row is ciphertext
     * addressed to nobody.
     */
    memberUserId: uuid('member_user_id').references(() => users.id, { onDelete: 'cascade' }),
    serviceTokenId: uuid('service_token_id').references(() => serviceTokens.id, {
      onDelete: 'cascade',
    }),
    invitationId: uuid('invitation_id').references(() => invitations.id, { onDelete: 'cascade' }),

    /** `xk2.x25519.` blob (type 6): the EDK sealed to the principal's public key. */
    edkSealed: bytea('edk_sealed').notNull(),
    /** `xk2.x25519.` blob (type 7): the EHK, same construction, different AAD. */
    ehkSealed: bytea('ehk_sealed').notNull(),
    /**
     * The 32-byte X25519 public key the two blobs were sealed to.
     *
     * Recorded because the signature binds it (spec §6.1) and every other place
     * it could be read from is mutable: a vault reset replaces
     * `user_keys.enc_public_key`, and an invitation's key is deleted at
     * acceptance. A deferred verifier that joined to those tables would report
     * every honest grant written before a reset as forged — and would be taking
     * the one field the signature pins *against the server* from a column the
     * server writes. Stored raw, not as an `xk2.` blob: a public key has no
     * version tag and no AAD (see `types.ts` in the client package).
     */
    recipientPublicKey: bytea('recipient_public_key').notNull(),
    /** `xk2.ed25519.` blob (type 8): the creator's signature over both (spec §6.1). */
    signature: bytea('signature').notNull(),
    /**
     * Whose Ed25519 key signed. Verification reads `user_keys.sign_public_key`
     * for this account, so the row names its own verification key rather than
     * leaving a verifier to guess which one to try.
     */
    signedByUserId: uuid('signed_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'env_key_grants_principal_check',
      sql`num_nonnulls(${t.memberUserId}, ${t.serviceTokenId}, ${t.invitationId}) = 1`,
    ),
    /**
     * One grant per principal per key version.
     *
     * Three partial unique indexes rather than one composite, because PostgreSQL
     * treats NULLs as distinct: a plain `UNIQUE (env_data_key_id, member_user_id,
     * service_token_id, invitation_id)` would happily admit two identical member
     * grants, since the two NULL columns make the rows "different". Inside a
     * partial index the column is never NULL, so uniqueness means what it says.
     *
     * Duplicates matter: two grants for one member is two answers to "which
     * sealed blob do I open", and a client that picked the wrong one would report
     * a decryption failure for an environment it genuinely has access to.
     */
    uniqueIndex('env_key_grants_member_unique')
      .on(t.envDataKeyId, t.memberUserId)
      .where(sql`${t.memberUserId} is not null`),
    uniqueIndex('env_key_grants_token_unique')
      .on(t.envDataKeyId, t.serviceTokenId)
      .where(sql`${t.serviceTokenId} is not null`),
    uniqueIndex('env_key_grants_invitation_unique')
      .on(t.envDataKeyId, t.invitationId)
      .where(sql`${t.invitationId} is not null`),
    // "Which environments can this person open?" — read on every dashboard
    // navigation and on the vault-reset cascade.
    index('env_key_grants_member_idx')
      .on(t.memberUserId)
      .where(sql`${t.memberUserId} is not null`),
    index('env_key_grants_key_idx').on(t.envDataKeyId),
  ],
);

/**
 * The queue of grants an admin could not seal.
 *
 * ── Why this table exists at all ──
 * Access is decided by people who may not hold the key. An owner can grant a
 * developer access to `production` without ever having opened `production`
 * themselves — and if they hold no grant on it, their browser has no EDK to seal.
 * The alternative designs are both worse: refusing the access change would make
 * the authorization model depend on who happens to hold which key, and silently
 * granting access with no key would leave a member who can list every secret
 * name and decrypt none of them, with nothing anywhere saying why.
 *
 * So the access change lands, and a row here records the debt. The next unlocked
 * member who *does* hold that environment's EDK fulfils it, and the row is
 * deleted in the same transaction as the grant it produced.
 *
 * ── Nothing here is secret ──
 * Every column is an id and a timestamp. A pending row is a *request*, not
 * authority and not key material: it grants nothing, and deleting it costs
 * nothing but the reminder.
 */
export const pendingKeyGrants = pgTable(
  'pending_key_grants',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    /**
     * Who is owed a key. Members only: a service token is given its grant at
     * creation by the creator's own client (Phase 4), and an invitation carries
     * its grants in the invitation itself — neither can be owed one later.
     */
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who made the access change that incurred the debt. For the banner and the audit trail. */
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One debt per person per environment. Widening a grant twice before anybody
    // fulfils it owes the same single key, and a second row would show the same
    // person twice in the "1 pending key share" banner.
    uniqueIndex('pending_key_grants_unique').on(t.environmentId, t.targetUserId),
    index('pending_key_grants_environment_idx').on(t.environmentId),
  ],
);
