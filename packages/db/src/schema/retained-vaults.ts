import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Argon2idParams } from '@xecret/core/crypto/client';
import { bytea } from './columns';
import { envDataKeys } from './env-keys';
import { users } from './identity';

/**
 * Retained vaults: a reset vault, kept for seven days (P23).
 *
 * See migration 0020 for the whole argument. The short version: a reset moves
 * the vault here instead of deleting it, the account sets up a new one at once,
 * and for seven days the old passphrase or a recovery code can bring the old
 * vault's environment keys back. **Nobody can delete one early** — the database
 * refuses a DELETE while `purge_after` is in the future, refuses any change to
 * the key material or the window, and pins the window to exactly seven days
 * with a CHECK. The scheduled purge removes it afterwards.
 *
 * Every column is copied verbatim from `user_keys`, `user_key_wraps` or
 * `env_key_grants`, and carries the property those tables carry: nothing here
 * is readable by this server.
 */

/** How long a reset vault stays recoverable. Mirrored by the CHECK in migration 0020. */
export const VAULT_RETENTION_DAYS = 7;
export const VAULT_RETENTION_MS = VAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const retainedVaults = pgTable(
  'retained_vaults',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    encAlgorithm: text('enc_algorithm').notNull(),
    encPublicKey: bytea('enc_public_key').notNull(),
    encPrivateKeyEnc: bytea('enc_private_key_enc').notNull(),
    signAlgorithm: text('sign_algorithm').notNull(),
    signPublicKey: bytea('sign_public_key').notNull(),
    signPrivateKeyEnc: bytea('sign_private_key_enc').notNull(),
    kdfSalt: bytea('kdf_salt').notNull(),
    kdfParams: jsonb('kdf_params').$type<Argon2idParams>().notNull(),
    unlockVerifierHash: bytea('unlock_verifier_hash').notNull(),
    /**
     * `SHA-256(HKDF(UK, "xecret.v2.uk-unlock-verifier"))`. A recovery presents
     * the verifier, which only somebody who opened this vault's User Key can
     * derive — whichever credential they opened it with.
     */
    ukUnlockVerifierHash: bytea('uk_unlock_verifier_hash').notNull(),
    vaultCreatedAt: timestamp('vault_created_at', { withTimezone: true }).notNull(),
    vaultRotatedAt: timestamp('vault_rotated_at', { withTimezone: true }),

    /** When the reset happened. */
    retainedAt: timestamp('retained_at', { withTimezone: true }).notNull(),
    /** `retainedAt` + seven days, exactly. Before it: recoverable and undeletable. */
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),

    /** The last time its keys were brought into a current vault. */
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
    /**
     * Failed recovery proofs, and the lockout they earned — abuse control on the
     * recovery endpoints, kept per retained vault like `user_keys`' own pair.
     */
    recoveryFailedAttempts: integer('recovery_failed_attempts').notNull().default(0),
    recoveryLockedUntil: timestamp('recovery_locked_until', { withTimezone: true }),
  },
  (t) => [
    check(
      'retained_vaults_window_check',
      sql`${t.purgeAfter} = ${t.retainedAt} + interval '168 hours'`,
    ),
    check(
      'retained_vaults_digest_check',
      sql`octet_length(${t.unlockVerifierHash}) = 32 and octet_length(${t.ukUnlockVerifierHash}) = 32`,
    ),
    check(
      'retained_vaults_public_keys_check',
      sql`octet_length(${t.encPublicKey}) = 32 and octet_length(${t.signPublicKey}) = 32`,
    ),
    check('retained_vaults_attempts_check', sql`${t.recoveryFailedAttempts} >= 0`),
    index('retained_vaults_user_idx').on(t.userId, t.purgeAfter),
    index('retained_vaults_purge_idx').on(t.purgeAfter),
  ],
);

export const RETAINED_WRAP_KINDS = ['passphrase', 'recovery'] as const;
export type RetainedWrapKind = (typeof RETAINED_WRAP_KINDS)[number];

export const retainedVaultWraps = pgTable(
  'retained_vault_wraps',
  {
    id: uuid('id').primaryKey(),
    retainedVaultId: uuid('retained_vault_id')
      .notNull()
      .references(() => retainedVaults.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RetainedWrapKind>().notNull(),
    /** `xk2.gcm.` blob (types 1–2), verbatim from `user_key_wraps`. */
    wrap: bytea('wrap').notNull(),
    lookupHash: bytea('lookup_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('retained_vault_wraps_kind_check', sql`${t.kind} in ('passphrase', 'recovery')`),
    check(
      'retained_vault_wraps_lookup_check',
      sql`(${t.kind} = 'recovery') = (${t.lookupHash} is not null)`,
    ),
    check(
      'retained_vault_wraps_lookup_length_check',
      sql`${t.lookupHash} is null or octet_length(${t.lookupHash}) = 32`,
    ),
    uniqueIndex('retained_vault_wraps_passphrase_unique')
      .on(t.retainedVaultId)
      .where(sql`${t.kind} = 'passphrase'`),
    uniqueIndex('retained_vault_wraps_lookup_unique')
      .on(t.retainedVaultId, t.lookupHash)
      .where(sql`${t.lookupHash} is not null`),
  ],
);

export const retainedVaultGrants = pgTable(
  'retained_vault_grants',
  {
    id: uuid('id').primaryKey(),
    retainedVaultId: uuid('retained_vault_id')
      .notNull()
      .references(() => retainedVaults.id, { onDelete: 'cascade' }),
    envDataKeyId: uuid('env_data_key_id')
      .notNull()
      .references(() => envDataKeys.id, { onDelete: 'cascade' }),
    /** `xk2.x25519.` blobs (types 6–7), sealed to the retained vault's public key. */
    edkSealed: bytea('edk_sealed').notNull(),
    ehkSealed: bytea('ehk_sealed').notNull(),
    recipientPublicKey: bytea('recipient_public_key').notNull(),
    signature: bytea('signature').notNull(),
    signedByUserId: uuid('signed_by_user_id')
      .notNull()
      .references(() => users.id),
    /** When the original grant was created. */
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('retained_vault_grants_key_unique').on(t.retainedVaultId, t.envDataKeyId),
    index('retained_vault_grants_key_idx').on(t.envDataKeyId),
  ],
);
