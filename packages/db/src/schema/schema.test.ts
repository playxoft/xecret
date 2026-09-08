import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  auditLogs,
  cliTokens,
  invitations,
  secretVersions,
  secrets,
  serviceTokens,
  sessions,
  userKeyWraps,
  userKeys,
  userPasskeys,
} from './index';
import { SECRET_VALUE_TYPES } from '@xecret/core/validation';

/**
 * These assert security properties of the schema, not implementation detail.
 *
 * Each one corresponds to a documented decision in
 * docs/architecture/database-schema.md or the threat model. They exist so that a
 * future well-meaning refactor cannot quietly remove a control — a schema change
 * that breaks one of these should force a conversation, not slip through review.
 */

const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(getTableConfig(table).columns.map((c) => [c.name, c]));

describe('credentials are never stored in a recoverable form', () => {
  // Threat T6: a database dump must not yield usable sessions or tokens.
  it.each([
    ['sessions', sessions, 'token_hash'],
    ['cli_tokens', cliTokens, 'token_hash'],
    ['service_tokens', serviceTokens, 'token_hash'],
    ['invitations', invitations, 'token_hash'],
  ])('%s stores only a hash, as bytea and NOT NULL', (_name, table, column) => {
    const col = columnsOf(table)[column];
    expect(col, `${column} must exist`).toBeDefined();
    expect(col!.getSQLType()).toBe('bytea');
    expect(col!.notNull).toBe(true);
  });

  it.each([
    ['sessions', sessions],
    ['cli_tokens', cliTokens],
    ['service_tokens', serviceTokens],
    ['invitations', invitations],
  ])('%s has no column that could hold a raw token', (_name, table) => {
    const names = Object.keys(columnsOf(table));
    // token_prefix is a deliberate, non-sensitive display fragment.
    const suspicious = names.filter(
      (n) => /token|secret/.test(n) && !n.endsWith('_hash') && n !== 'token_prefix',
    );
    expect(suspicious).toEqual([]);
  });
});

describe('secret ciphertext', () => {
  it('is bytea, never text — no base64 round-tripping in the database', () => {
    const cols = columnsOf(secretVersions);
    expect(cols['ciphertext']!.getSQLType()).toBe('bytea');
    expect(cols['iv']!.getSQLType()).toBe('bytea');
    expect(cols['value_hmac']!.getSQLType()).toBe('bytea');
  });

  it('always records which key encrypted it, so rotation is possible', () => {
    const cols = columnsOf(secretVersions);
    expect(cols['env_key_id']!.notNull).toBe(true);
    expect(cols['algorithm']!.notNull).toBe(true);
  });

  it('never allows a null IV — AES-GCM without a unique IV is broken', () => {
    expect(columnsOf(secretVersions)['iv']!.notNull).toBe(true);
  });
});

describe('service tokens limit blast radius', () => {
  // Threat T5: a compromised CI pipeline must not reach beyond one environment.
  it('are scoped to exactly one environment, enforced by NOT NULL', () => {
    const cols = columnsOf(serviceTokens);
    expect(cols['environment_id']!.notNull).toBe(true);
    expect(cols['project_id']!.notNull).toBe(true);
    expect(cols['org_id']!.notNull).toBe(true);
  });

  it('carry no user identity, so a stolen CI token cannot act as a person', () => {
    expect(columnsOf(serviceTokens)['user_id']).toBeUndefined();
  });

  it('default to read-only', () => {
    expect(columnsOf(serviceTokens)['access_level']!.default).toBe('read');
  });
});

describe('audit log', () => {
  // Audit records must outlive the rows they describe: deleting a project must
  // not erase the record that it existed and who deleted it.
  it('declares no foreign keys', () => {
    expect(getTableConfig(auditLogs).foreignKeys).toHaveLength(0);
  });

  it('denormalises the actor label so records survive user deletion', () => {
    expect(columnsOf(auditLogs)['actor_label']).toBeDefined();
  });

  it('records an outcome, so denials are logged as well as successes', () => {
    expect(columnsOf(auditLogs)['outcome']!.notNull).toBe(true);
  });

  it('has no column that could hold a secret value', () => {
    const names = Object.keys(columnsOf(auditLogs));
    expect(names).not.toContain('value');
    expect(names).not.toContain('plaintext');
    expect(names).not.toContain('ciphertext');
  });
});

describe('the secret value type', () => {
  it('defaults to string, so every row written before the column is valid', () => {
    // Not merely tolerated: `string` accepts anything, so a backfilled row is
    // correct under its own declared type rather than exempt from checking.
    expect(columnsOf(secrets)['value_type']!.default).toBe('string');
    expect(columnsOf(secrets)['value_type']!.notNull).toBe(true);
  });

  it('constrains the column to exactly the types the application knows', () => {
    // The CHECK and `SECRET_VALUE_TYPES` are two halves of one rule, kept in
    // sync by hand in two files. This is what makes that pairing enforced: add a
    // type to the list without widening the constraint and every write of it
    // fails in production, which is the failure this test exists to prevent.
    const constraint = getTableConfig(secrets).checks.find(
      (check) => check.name === 'secrets_value_type_check',
    );
    expect(constraint, 'secrets_value_type_check must exist').toBeDefined();

    const sql = constraint!.value.queryChunks
      .map((chunk) => (typeof chunk === 'object' && 'value' in chunk ? chunk.value : ''))
      .join('');

    for (const type of SECRET_VALUE_TYPES) {
      expect(sql, `${type} must be allowed by the CHECK constraint`).toContain(`'${type}'`);
    }
    // And nothing beyond them: a stray value in the constraint would let a write
    // land that the application cannot interpret when it reads the row back.
    const quoted = sql.match(/'[a-z0-9]+'/g) ?? [];
    expect(new Set(quoted.map((entry) => entry.slice(1, -1)))).toEqual(new Set(SECRET_VALUE_TYPES));
  });
});

describe('the user vault', () => {
  it('holds no column a server could decrypt anything with', () => {
    // The claim ADR 0009 makes, checked against the column list rather than
    // against prose. Everything here is a public value or an opaque ciphertext;
    // a future column named for key material should fail this outright.
    const cols = Object.keys(columnsOf(userKeys));
    for (const forbidden of [
      'user_key',
      'private_key',
      'passphrase',
      'stretched_key',
      'unlock_verifier',
    ]) {
      expect(cols, `user_keys must not carry a ${forbidden} column`).not.toContain(forbidden);
    }
    // Both verifiers are stored only as digests, and their names say so.
    expect(cols).toContain('unlock_verifier_hash');
    expect(cols).toContain('uk_unlock_verifier_hash');
  });

  it('keeps the two unlock verifiers in separate columns', () => {
    // A passkey unlock opens the User Key directly and can never produce the
    // Stretched Key branch, so it presents its own proof. Two columns rather
    // than one accepting either value: one column would mean a value captured
    // from either path satisfies both, which is the confusion the distinct HKDF
    // info strings exist to prevent.
    const cols = columnsOf(userKeys);
    expect(cols['unlock_verifier_hash']).not.toBe(cols['uk_unlock_verifier_hash']);
    expect(cols['uk_unlock_verifier_hash']!.notNull).toBe(true);
  });

  it('stores every ciphertext as bytea, never as text', () => {
    // The schema-wide rule from `columns.ts`: base64 in the database wastes a
    // third of every row and invites accidental logging of what looks like a
    // harmless string.
    const keys = columnsOf(userKeys);
    for (const column of [
      'enc_public_key',
      'enc_private_key_enc',
      'sign_public_key',
      'sign_private_key_enc',
      'kdf_salt',
      'unlock_verifier_hash',
      'uk_unlock_verifier_hash',
    ]) {
      expect(keys[column]!.getSQLType(), column).toBe('bytea');
      expect(keys[column]!.notNull, column).toBe(true);
    }
    expect(columnsOf(userKeyWraps)['wrap']!.getSQLType()).toBe('bytea');
    expect(columnsOf(userKeyWraps)['lookup_hash']!.getSQLType()).toBe('bytea');
  });

  it('counts failures on the row, so a lockout survives a restart', () => {
    // Held in the database rather than in an isolate: a Worker isolate is
    // recycled constantly, and an attempt counter that lives in one is a
    // counter an attacker resets by waiting.
    const cols = columnsOf(userKeys);
    for (const column of ['failed_attempts', 'recovery_failed_attempts']) {
      expect(cols[column]!.notNull, column).toBe(true);
      expect(cols[column]!.default, column).toBe(0);
    }
    expect(cols['locked_until']).toBeDefined();
    expect(cols['recovery_locked_until']).toBeDefined();
  });

  it('counts the recovery surface separately from the passphrase one', () => {
    // Sharing one counter would let a mistyped recovery code spend the budget
    // that protects the passphrase — see `auth/vault.ts`.
    const cols = columnsOf(userKeys);
    expect(cols['failed_attempts']).not.toBe(cols['recovery_failed_attempts']);
  });

  it('keeps the unlock separate from the session itself', () => {
    // Authentication and unlock are different facts: revoking is not locking,
    // and a 30-day cookie must not imply 30 days of reach into key material.
    const cols = columnsOf(sessions);
    expect(cols['vault_unlocked_at']).toBeDefined();
    expect(cols['vault_unlocked_at']!.notNull).toBe(false);
    // The retired PIN's column must be gone, not merely unused: a stale
    // timestamp would read as an unlock nobody performed.
    expect(cols['pin_verified_at']).toBeUndefined();
  });

  it('allows exactly one live passphrase wrap per account', () => {
    // The load-bearing constraint. Two live wraps would mean two passphrases
    // open the same vault, and the older would keep working long after its
    // owner believed they had changed it.
    const index = getTableConfig(userKeyWraps).indexes.find(
      (entry) => entry.config.name === 'user_key_wraps_passphrase_unique',
    );

    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    expect(index!.config.where).toBeDefined();
  });

  it('ties each kind-specific column to its kind, in both directions', () => {
    // A recovery wrap without a lookup hash could never be found; a passphrase
    // wrap carrying a passkey_id would be cascade-deleted by unenrolling a
    // passkey, taking the account's only way in with it.
    const checks = new Map(
      getTableConfig(userKeyWraps).checks.map((entry) => [entry.name, entry.value.queryChunks]),
    );

    expect([...checks.keys()]).toEqual(
      expect.arrayContaining([
        'user_key_wraps_kind_check',
        'user_key_wraps_lookup_check',
        'user_key_wraps_passkey_check',
        'user_key_wraps_used_check',
      ]),
    );
  });

  it('restates the wrap kinds the crypto spec pins, and nothing else', () => {
    const check = getTableConfig(userKeyWraps).checks.find(
      (entry) => entry.name === 'user_key_wraps_kind_check',
    );
    const sql = check!.value.queryChunks
      .map((chunk) => (typeof chunk === 'object' && 'value' in chunk ? chunk.value : ''))
      .join('');

    for (const kind of ['passphrase', 'recovery', 'prf']) {
      expect(sql, `${kind} must be allowed by the CHECK constraint`).toContain(`'${kind}'`);
    }
    // The retired PIN was never a wrap kind and must not become one: ADR 0009
    // §4.4 records why the device PIN's design did not survive review.
    expect(sql).not.toContain('pin');
  });

  it('makes a credential id unique across the installation', () => {
    // A WebAuthn credential id identifies an authenticator's credential
    // globally, and the same one under two accounts means something has gone
    // wrong rather than that two people share a key.
    expect(columnsOf(userPasskeys)['credential_id']!.isUnique).toBe(true);
    expect(columnsOf(userPasskeys)['credential_id']!.getSQLType()).toBe('bytea');
  });
});
