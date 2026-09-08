import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  auditLogs,
  cliTokens,
  envDataKeys,
  envHmacKeys,
  envKeyGrants,
  environments,
  invitations,
  pendingKeyGrants,
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

/**
 * The SQL text of one named CHECK constraint, column names included.
 *
 * Drizzle keeps a constraint as an array of query chunks: literal fragments
 * carry `value`, and an interpolated `${t.someColumn}` arrives as a `Column`
 * carrying `name`. Both are rendered here, because for these constraints the
 * *columns* are half of what is being asserted — a check that compared the right
 * operator against the wrong pair of columns would read identically otherwise.
 *
 * Written out once because, as the schema takes on modes, more of its invariants
 * live in CHECKs than in NOT NULL flags: a test that could only read the flags
 * would quietly stop covering them.
 */
function checkSql(table: Parameters<typeof getTableConfig>[0], name: string): string {
  const constraint = getTableConfig(table).checks.find((entry) => entry.name === name);
  expect(constraint, `${name} must exist`).toBeDefined();

  return constraint!.value.queryChunks
    .map((chunk) => {
      if (typeof chunk !== 'object' || chunk === null) return '';
      if ('value' in chunk) return String(chunk.value);
      if ('name' in chunk && typeof chunk.name === 'string') return chunk.name;
      return '';
    })
    .join('');
}

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
    // Neither key column is NOT NULL on its own any more — a row names one of
    // them, never both — so what carries the invariant is the CHECK below rather
    // than a column flag. `algorithm` still is: every row names a construction.
    expect(columnsOf(secretVersions)['algorithm']!.notNull).toBe(true);
    expect(checkSql(secretVersions, 'secret_versions_key_check')).toContain('num_nonnulls');
  });

  it('names exactly one key, so no row is readable two ways or none', () => {
    // The constraint that makes the dual-mode period safe. A row naming both keys
    // claims two different sets of bytes decrypt it; a row naming neither is
    // ciphertext nothing can ever open — and would read as an e2ee row to any
    // query testing `env_key_id IS NULL`. Both are silent, permanent data loss.
    const sql = checkSql(secretVersions, 'secret_versions_key_check');
    expect(sql).toContain('env_key_id');
    expect(sql).toContain('env_data_key_id');
    expect(sql).toContain('= 1');
  });

  it('never allows a null IV on a row the server encrypted', () => {
    // The original invariant, narrowed to exactly the rows it ever applied to.
    // AES-GCM without a unique IV is broken, and a server-envelope row still
    // cannot be written without one. An e2ee row has no IV *column* because the
    // spec puts the IV inside the blob (§2.1), where it travels with the
    // ciphertext it belongs to and cannot be paired with the wrong one.
    //
    // The CHECK is a biconditional in both directions on purpose: the reverse
    // half stops a stray IV being written beside a blob that already contains
    // one, where it could only ever be used by mistake.
    const sql = checkSql(secretVersions, 'secret_versions_server_iv_check');
    expect(sql).toContain('env_key_id');
    expect(sql).toContain('iv');
  });

  it('ties the client algorithm to the client-encrypted rows, and to no others', () => {
    const sql = checkSql(secretVersions, 'secret_versions_client_algorithm_check');
    expect(sql).toContain('env_data_key_id');
    expect(sql).toContain('client_algorithm');
  });

  it('stores an encrypted note as bytea beside the plaintext one', () => {
    // Both columns exist through the migration: `note` serves `server`-mode rows
    // and `enc_note` serves `e2ee` ones. Nullable in both directions, because
    // which is written depends on `environments.encryption_mode` — a join away,
    // and therefore unreachable from a row constraint.
    const cols = columnsOf(secrets);
    expect(cols['note']!.getSQLType()).toBe('text');
    expect(cols['enc_note']!.getSQLType()).toBe('bytea');
    expect(cols['enc_note']!.notNull).toBe(false);
  });
});

describe('environment data keys hold no key material', () => {
  it('records identity and version only — the bytes live in the grants', () => {
    // The property that separates this table from `env_keys` beside it, and the
    // whole of ADR 0009: `env_keys.wrapped_key` is a key this deployment can
    // unwrap, and its successor deliberately is not. A future column named for
    // key material should fail this outright.
    const cols = Object.keys(columnsOf(envDataKeys));
    for (const forbidden of ['wrapped_key', 'key', 'wrap_iv', 'secret', 'edk']) {
      expect(cols, `env_data_keys must not carry a ${forbidden} column`).not.toContain(forbidden);
    }
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'environment_id', 'version', 'status', 'created_by']),
    );
    expect(Object.keys(columnsOf(envHmacKeys))).not.toContain('key');
  });

  it('allows exactly one active key per environment', () => {
    // Two active rows would be two answers to "which key does the next write
    // use", and a client picking the older one would encrypt under a key a
    // revoked principal still holds — silently undoing the rotation that retired
    // it. Partial, so the retired history is unbounded while the present is
    // unique, exactly like `user_key_wraps_passphrase_unique`.
    const index = getTableConfig(envDataKeys).indexes.find(
      (entry) => entry.config.name === 'env_data_keys_active_unique',
    );

    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    expect(index!.config.where).toBeDefined();
  });

  it('restates the statuses the ADR pins, and nothing else', () => {
    const sql = checkSql(envDataKeys, 'env_data_keys_status_check');
    expect(sql).toContain(`'active'`);
    expect(sql).toContain(`'retired'`);
    const quoted = sql.match(/'[a-z]+'/g) ?? [];
    expect(new Set(quoted.map((entry) => entry.slice(1, -1)))).toEqual(
      new Set(['active', 'retired']),
    );
  });
});

describe('environment key grants', () => {
  it('names exactly one principal, in the same shape as every other such rule', () => {
    // A `kind` column beside three nullable ids would let the two disagree, and
    // the kind is what goes into the AAD (spec §4.2) — so a disagreement produces
    // a grant the principal it names cannot open. Deriving the kind from which
    // column is set makes that unrepresentable.
    const sql = checkSql(envKeyGrants, 'env_key_grants_principal_check');
    expect(sql).toContain('num_nonnulls');
    for (const column of ['member_user_id', 'service_token_id', 'invitation_id']) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('= 1');
  });

  it('requires a creator signature on every row', () => {
    // Verification is deferred past v1; the columns are not. Turning verification
    // on later has to be a client update rather than a data migration over grants
    // that never carried a signature — which a nullable column would guarantee.
    const cols = columnsOf(envKeyGrants);
    expect(cols['signature']!.notNull).toBe(true);
    expect(cols['signature']!.getSQLType()).toBe('bytea');
    expect(cols['signed_by_user_id']!.notNull).toBe(true);
  });

  it('stores the two sealed keys separately, as bytea', () => {
    // Separate because the EHK is re-sealed *unchanged* across an EDK rotation
    // while the EDK is replaced: one column holding a pair would mean re-sealing
    // a key that did not change, on every rotation, for nothing.
    const cols = columnsOf(envKeyGrants);
    expect(cols['edk_sealed']!.getSQLType()).toBe('bytea');
    expect(cols['ehk_sealed']!.getSQLType()).toBe('bytea');
    expect(cols['edk_sealed']!.notNull).toBe(true);
    expect(cols['ehk_sealed']!.notNull).toBe(true);
  });

  it('permits one grant per principal per key version, NULLs notwithstanding', () => {
    // Three partial unique indexes rather than one composite: PostgreSQL treats
    // NULLs as distinct, so a plain UNIQUE over all four columns would admit two
    // identical member grants because the two NULL columns make the rows
    // "different". Two grants for one member is two answers to "which sealed blob
    // do I open".
    const indexes = new Map(
      getTableConfig(envKeyGrants).indexes.map((entry) => [entry.config.name, entry.config]),
    );

    for (const name of [
      'env_key_grants_member_unique',
      'env_key_grants_token_unique',
      'env_key_grants_invitation_unique',
    ]) {
      expect(indexes.get(name), `${name} must exist`).toBeDefined();
      expect(indexes.get(name)!.unique, name).toBe(true);
      expect(indexes.get(name)!.where, name).toBeDefined();
    }
  });
});

describe('the pending key-grant queue', () => {
  it('holds ids and timestamps, never key material', () => {
    // A pending row is a request, not authority: it grants nothing, and the
    // member it names still cannot decrypt anything until somebody seals a real
    // grant for them.
    const cols = Object.keys(columnsOf(pendingKeyGrants));
    for (const forbidden of ['sealed', 'wrap', 'key', 'signature']) {
      expect(cols, `pending_key_grants must not carry a ${forbidden} column`).not.toContain(
        forbidden,
      );
    }
    expect(cols).toEqual(
      expect.arrayContaining(['environment_id', 'target_user_id', 'requested_by']),
    );
  });

  it('records one debt per person per environment', () => {
    const index = getTableConfig(pendingKeyGrants).indexes.find(
      (entry) => entry.config.name === 'pending_key_grants_unique',
    );
    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
  });
});

describe('the encryption mode', () => {
  it('defaults new environments to end-to-end encryption', () => {
    // A migration mechanism, not a product option: nothing in the API lets a
    // caller choose. Migration 0013 backfills existing rows to `server` through
    // an ADD COLUMN default and then changes the default to this one, which is
    // what makes every environment created from that deployment onward e2ee.
    const cols = columnsOf(environments);
    expect(cols['encryption_mode']!.notNull).toBe(true);
    expect(cols['encryption_mode']!.default).toBe('e2ee');
  });

  it('admits the two modes and nothing else', () => {
    const sql = checkSql(environments, 'environments_encryption_mode_check');
    const quoted = sql.match(/'[a-z0-9]+'/g) ?? [];
    expect(new Set(quoted.map((entry) => entry.slice(1, -1)))).toEqual(new Set(['server', 'e2ee']));
  });
});

describe('service tokens as e2ee principals', () => {
  it('store a public key and never a private one', () => {
    // The private scalar lives only inside the token string its creator was shown
    // once. The server holds a hash it can check and a public key it can seal to,
    // and nothing that opens either — which is what lets a rotation re-seal to
    // every token without anybody regenerating one.
    const cols = columnsOf(serviceTokens);
    expect(cols['public_key']!.getSQLType()).toBe('bytea');
    // Nullable: Phase 4's creation flow fills it, and a grant to a token without
    // one is refused rather than sealed to nothing.
    expect(cols['public_key']!.notNull).toBe(false);
    expect(Object.keys(cols)).not.toContain('private_key');
  });

  it('give an invitation a public key and never the fragment that opens it', () => {
    // The fragment travels to the invitee out of band, over a different channel
    // from the emailed token, and never reaches the server (spec §10). A column
    // for it would collapse the two-channel design into one.
    const cols = columnsOf(invitations);
    expect(cols['invite_public_key']!.getSQLType()).toBe('bytea');
    expect(Object.keys(cols)).not.toContain('invite_fragment');
    expect(Object.keys(cols)).not.toContain('invite_private_key');
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
