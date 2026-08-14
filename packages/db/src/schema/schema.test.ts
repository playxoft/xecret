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
  pinResetTokens,
  userPins,
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

describe('the unlock PIN', () => {
  it('stores a derived hash, never the PIN', () => {
    const cols = columnsOf(userPins);
    expect(cols['pin_hash']!.notNull).toBe(true);
    expect(Object.keys(cols)).not.toContain('pin');
  });

  it('counts failures on the row, so a lockout survives a restart', () => {
    // Held in the database rather than in an isolate: a Worker isolate is
    // recycled constantly, and an attempt counter that lives in one is a
    // counter an attacker resets by waiting.
    expect(columnsOf(userPins)['failed_attempts']!.notNull).toBe(true);
    expect(columnsOf(userPins)['failed_attempts']!.default).toBe(0);
    expect(columnsOf(userPins)['locked_until']).toBeDefined();
  });

  it('keeps the unlock separate from the session itself', () => {
    // Authentication and unlock are different facts: revoking is not locking,
    // and a 30-day cookie must not imply 30 days of reach into secrets.
    const cols = columnsOf(sessions);
    expect(cols['pin_verified_at']).toBeDefined();
    expect(cols['pin_verified_at']!.notNull).toBe(false);
  });

  it('stores only a hash of a reset link', () => {
    const cols = columnsOf(pinResetTokens);
    expect(cols['token_hash']!.getSQLType()).toBe('bytea');
    expect(cols['token_hash']!.notNull).toBe(true);
    expect(cols['expires_at']!.notNull).toBe(true);
    expect(cols['consumed_at']).toBeDefined();
  });
});
