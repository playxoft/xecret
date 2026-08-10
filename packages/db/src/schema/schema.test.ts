import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  auditLogs,
  cliTokens,
  invitations,
  secretVersions,
  serviceTokens,
  sessions,
} from './index';

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
