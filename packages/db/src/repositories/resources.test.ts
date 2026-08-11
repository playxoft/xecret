import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { EnvelopeService } from '@xecret/core/crypto';
import type { KeyProvider } from '@xecret/core/crypto';
import * as schema from '../schema';
import type { Database } from '../client';
import * as auditRepository from './audit';
import { appendAuditEvents, clampAuditRange, MAX_AUDIT_RANGE_DAYS, queryAuditLogs } from './audit';
import {
  createEnvironment,
  findEnvironmentBySlug,
  listEnvironments,
  loadEnvironmentKeyChain,
  softDeleteEnvironment,
  updateEnvironment,
} from './environments';
import {
  findProjectById,
  findProjectBySlug,
  listProjects,
  restoreProject,
  softDeleteProject,
  updateProject,
} from './projects';
import {
  addSecretVersion,
  countSecrets,
  createSecret,
  findSecretByName,
  getSecretVersion,
  listSecrets,
  listSecretVersions,
  loadEnvironmentSecrets,
  restoreSecret,
  softDeleteSecret,
} from './secrets';
import { isIpAllowed, listCliTokens, listServiceTokens, revokeCliToken } from './tokens';
import { RepositoryError } from './shared';

/**
 * What these tests prove, and what they do not.
 *
 * **They prove query *shape*.** Each repository function is run against a
 * Drizzle instance whose driver is replaced by a recorder: the SQL and bound
 * parameters are captured, no connection is opened, and every statement returns
 * zero rows. That is enough to assert the properties that a code review is bad
 * at catching consistently — that a tenant predicate is present, that a select
 * list does not reach for ciphertext or a token hash, that the bulk read path is
 * one statement rather than a loop. These are structural invariants, and a
 * structural test is the right instrument for them.
 *
 * **They do not prove behaviour.** Nothing here executes against PostgreSQL, so
 * nothing here demonstrates that `DISTINCT ON` returns the newest version, that
 * the partial unique indexes conflict when they should, that `MAX(version) + 1`
 * races the way the comments claim, or that a soft-deleted parent actually hides
 * its children. Those need integration tests against a real database and must
 * exist before this ships. Treating this file as coverage of the data layer
 * would be worse than having no tests at all, because it reads like coverage.
 *
 * The pure-logic tests at the bottom — `isIpAllowed` and `clampAuditRange` — are
 * the exception: those are complete, and they are the two places in this
 * directory where an authorization or scanning decision is made in JavaScript.
 */

const ORG_ID = '01930000-0000-7000-8000-000000000001';
const PROJECT_ID = '01930000-0000-7000-8000-000000000002';
const ENVIRONMENT_ID = '01930000-0000-7000-8000-000000000003';
const SECRET_ID = '01930000-0000-7000-8000-000000000004';
const USER_ID = '01930000-0000-7000-8000-000000000005';
const TOKEN_ID = '01930000-0000-7000-8000-000000000006';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * A Drizzle database whose driver records statements instead of running them.
 *
 * `postgres.js` is only ever reached through `unsafe`, `begin`, and `savepoint`,
 * so those three are all a stand-in needs. Transactions therefore execute their
 * callback inline: this harness verifies the statements a transaction issues,
 * never its atomicity, which is a database property and untestable from here.
 */
function recordingDatabase(): { db: Database; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });
      const result = Promise.resolve([]) as Promise<never[]> & { values: () => Promise<never[]> };
      result.values = () => Promise.resolve([]);
      return result;
    },
    begin: <T>(run: (client: unknown) => Promise<T>) => run(client),
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

/**
 * Runs a repository call that is expected to fail because the recorder returns
 * no rows. Only `RepositoryError` is swallowed — anything else is a real defect
 * and must still fail the test.
 */
async function runRecording(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof RepositoryError)) throw error;
  }
}

/** Never invoked: the queries these tests drive stop before any key is touched. */
const unusedKeyProvider: KeyProvider = {
  getRootKey: () => Promise.reject(new Error('key provider must not be reached')),
  currentVersion: () => 1,
};

const ORG_PREDICATE = /"org_id" = \$\d+/;

describe('cross-tenant isolation (threat T2)', () => {
  /**
   * Reads that must never be satisfiable with a child id alone. `environments`,
   * `secrets`, and `secret_versions` have no `org_id` column, so for those the
   * predicate can only appear via a join or a correlated subquery — which is
   * exactly the construct a well-meaning simplification tends to remove.
   */
  const orgScopedReads: ReadonlyArray<readonly [string, (db: Database) => Promise<unknown>]> = [
    ['findProjectBySlug', (db) => findProjectBySlug(db, ORG_ID, 'api')],
    ['findProjectById', (db) => findProjectById(db, ORG_ID, PROJECT_ID)],
    ['listProjects', (db) => listProjects(db, ORG_ID)],
    ['updateProject', (db) => updateProject(db, ORG_ID, PROJECT_ID, { name: 'API' })],
    ['softDeleteProject', (db) => softDeleteProject(db, ORG_ID, PROJECT_ID)],
    ['restoreProject', (db) => restoreProject(db, ORG_ID, PROJECT_ID)],
    ['listEnvironments', (db) => listEnvironments(db, ORG_ID, PROJECT_ID)],
    ['findEnvironmentBySlug', (db) => findEnvironmentBySlug(db, ORG_ID, PROJECT_ID, 'prod')],
    ['updateEnvironment', (db) => updateEnvironment(db, ORG_ID, ENVIRONMENT_ID, { name: 'Prod' })],
    ['softDeleteEnvironment', (db) => softDeleteEnvironment(db, ORG_ID, ENVIRONMENT_ID)],
    ['loadEnvironmentKeyChain', (db) => loadEnvironmentKeyChain(db, ORG_ID, ENVIRONMENT_ID)],
    ['listSecrets', (db) => listSecrets(db, ORG_ID, ENVIRONMENT_ID)],
    ['findSecretByName', (db) => findSecretByName(db, ORG_ID, ENVIRONMENT_ID, 'DATABASE_URL')],
    ['listSecretVersions', (db) => listSecretVersions(db, ORG_ID, SECRET_ID)],
    ['getSecretVersion', (db) => getSecretVersion(db, ORG_ID, SECRET_ID, 3)],
    ['countSecrets', (db) => countSecrets(db, ORG_ID, ENVIRONMENT_ID)],
    ['softDeleteSecret', (db) => softDeleteSecret(db, ORG_ID, SECRET_ID)],
    ['restoreSecret', (db) => restoreSecret(db, ORG_ID, SECRET_ID)],
    ['listCliTokens', (db) => listCliTokens(db, ORG_ID, USER_ID)],
    ['listServiceTokens', (db) => listServiceTokens(db, ORG_ID)],
    ['revokeCliToken', (db) => revokeCliToken(db, ORG_ID, TOKEN_ID)],
    ['queryAuditLogs', (db) => queryAuditLogs(db, { orgId: ORG_ID })],
  ];

  for (const [name, run] of orgScopedReads) {
    it(`${name} constrains every statement to one organisation`, async () => {
      const { db, statements } = recordingDatabase();
      await runRecording(() => run(db));

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement.sql, statement.sql).toMatch(ORG_PREDICATE);
        expect(statement.params).toContain(ORG_ID);
      }
    });
  }

  /**
   * Writes resolve tenancy first and then insert, so only the leading statement
   * carries the predicate — but it must be the leading one, before anything is
   * written.
   */
  const orgScopedWrites: ReadonlyArray<readonly [string, (db: Database) => Promise<unknown>]> = [
    [
      'createEnvironment',
      (db) =>
        createEnvironment(db, {
          orgId: ORG_ID,
          projectId: PROJECT_ID,
          name: 'Production',
          slug: 'prod',
          envelope: new EnvelopeService(unusedKeyProvider),
        }),
    ],
    [
      'createSecret',
      (db) =>
        createSecret(db, {
          orgId: ORG_ID,
          environmentId: ENVIRONMENT_ID,
          name: 'DATABASE_URL',
          envKeyId: ENVIRONMENT_ID,
          encrypted: {
            ciphertext: new Uint8Array([1, 2, 3]),
            iv: new Uint8Array(12),
            algorithm: 'AES-256-GCM',
          },
          createdBy: USER_ID,
        }),
    ],
    [
      'addSecretVersion',
      (db) =>
        addSecretVersion(db, {
          orgId: ORG_ID,
          secretId: SECRET_ID,
          envKeyId: ENVIRONMENT_ID,
          encrypted: {
            ciphertext: new Uint8Array([1, 2, 3]),
            iv: new Uint8Array(12),
            algorithm: 'AES-256-GCM',
          },
          createdBy: USER_ID,
        }),
    ],
  ];

  for (const [name, run] of orgScopedWrites) {
    it(`${name} resolves tenancy before writing anything`, async () => {
      const { db, statements } = recordingDatabase();
      await runRecording(() => run(db));

      const first = statements[0];
      expect(first, 'expected at least one statement').toBeDefined();
      expect(first!.sql).toMatch(/^select /);
      expect(first!.sql).toMatch(ORG_PREDICATE);
      expect(first!.params).toContain(ORG_ID);
    });
  }
});

describe('listings never fetch material they will not use', () => {
  async function sqlOf(run: (db: Database) => Promise<unknown>): Promise<string> {
    const { db, statements } = recordingDatabase();
    await runRecording(() => run(db));
    expect(statements).toHaveLength(1);
    return statements[0]!.sql;
  }

  it('listSecrets selects no ciphertext', async () => {
    // The dashboard's default view must not pull payloads it will not decrypt.
    const sql = await sqlOf((db) => listSecrets(db, ORG_ID, ENVIRONMENT_ID));
    expect(sql).not.toMatch(/ciphertext/);
    expect(sql).not.toMatch(/value_hmac/);
  });

  it('listSecretVersions selects no ciphertext', async () => {
    const sql = await sqlOf((db) => listSecretVersions(db, ORG_ID, SECRET_ID));
    expect(sql).not.toMatch(/ciphertext/);
    expect(sql).not.toMatch(/value_hmac/);
  });

  it('getSecretVersion does select ciphertext, so the assertions above mean something', async () => {
    const sql = await sqlOf((db) => getSecretVersion(db, ORG_ID, SECRET_ID, 1));
    expect(sql).toMatch(/"ciphertext"/);
    expect(sql).toMatch(/"iv"/);
    expect(sql).toMatch(/"env_key_id"/);
    expect(sql).toMatch(/"version"/);
  });

  it('listCliTokens selects no token hash', async () => {
    const sql = await sqlOf((db) => listCliTokens(db, ORG_ID, USER_ID));
    expect(sql).not.toMatch(/token_hash/);
    expect(sql).toMatch(/"token_prefix"/);
  });

  it('listServiceTokens selects no token hash', async () => {
    const sql = await sqlOf((db) => listServiceTokens(db, ORG_ID));
    expect(sql).not.toMatch(/token_hash/);
    expect(sql).toMatch(/"token_prefix"/);
  });
});

describe('the bulk read path stays within its query budget', () => {
  it('loadEnvironmentSecrets is a single DISTINCT ON statement, not a loop', async () => {
    const { db, statements } = recordingDatabase();
    await loadEnvironmentSecrets(db, ORG_ID, ENVIRONMENT_ID);

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(/distinct on \("secret_versions"\."secret_id"\)/);
    // The ordering is what makes DISTINCT ON pick the newest version, and what
    // lets `secret_versions_current_idx` serve the query without a sort.
    expect(statements[0]!.sql).toMatch(
      /order by "secret_versions"\."secret_id" asc, "secret_versions"\."version" desc/,
    );
  });

  it('resolves an entire environment in three queries', async () => {
    // Key chain, secrets, audit record — the budget from
    // docs/architecture/system-architecture.md §4, which exists because a Worker
    // invocation may hold only six outgoing connections at once.
    const { db, statements } = recordingDatabase();

    await loadEnvironmentKeyChain(db, ORG_ID, ENVIRONMENT_ID);
    await loadEnvironmentSecrets(db, ORG_ID, ENVIRONMENT_ID);
    await appendAuditEvents(db, [
      {
        orgId: ORG_ID,
        actorType: 'service_token',
        actorId: TOKEN_ID,
        actorLabel: 'ci@github',
        action: 'secret.read',
        resourceType: 'environment',
        resourceId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        outcome: 'success',
        ipAddress: '203.0.113.7',
        userAgent: 'xecret-cli/0.1.0',
        requestId: 'req-1',
        metadata: { secretCount: 42, source: 'ci' },
      },
    ]);

    expect(statements).toHaveLength(3);
  });

  it('appends many audit events as one multi-row insert', async () => {
    const { db, statements } = recordingDatabase();

    await appendAuditEvents(
      db,
      Array.from({ length: 5 }, () => ({
        orgId: ORG_ID,
        actorType: 'user' as const,
        actorId: USER_ID,
        actorLabel: 'someone@example.com',
        action: 'secret.updated' as const,
        resourceType: 'secret',
        resourceId: SECRET_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        outcome: 'success' as const,
        ipAddress: null,
        userAgent: null,
        requestId: null,
        metadata: {},
      })),
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(/^insert into "audit_logs"/);
  });
});

describe('the audit log is append-only', () => {
  it('exports no function that could mutate history', () => {
    // Migration 0009 grants the application role INSERT and SELECT on
    // `audit_logs` and nothing else. This asserts the module cannot drift away
    // from that grant without someone noticing.
    const mutators = Object.keys(auditRepository).filter((name) => /update|delete/i.test(name));
    expect(mutators).toEqual([]);
  });

  it('issues only INSERT and SELECT statements', async () => {
    const { db, statements } = recordingDatabase();

    await queryAuditLogs(db, { orgId: ORG_ID, action: 'secret.read' });
    await appendAuditEvents(db, [
      {
        orgId: ORG_ID,
        actorType: 'system',
        actorId: null,
        actorLabel: null,
        action: 'key.rotated',
        resourceType: null,
        resourceId: null,
        projectId: null,
        environmentId: null,
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
        requestId: null,
        metadata: {},
      },
    ]);

    for (const statement of statements) {
      expect(statement.sql).toMatch(/^(select|insert) /);
    }
  });

  it('paginates by keyset rather than offset', async () => {
    const { db, statements } = recordingDatabase();

    await queryAuditLogs(db, {
      orgId: ORG_ID,
      cursor: { createdAt: new Date('2026-07-01T00:00:00.000Z'), id: SECRET_ID },
    });

    const sql = statements[0]!.sql;
    expect(sql).not.toMatch(/offset/);
    expect(sql).toMatch(/\("audit_logs"\."created_at", "audit_logs"\."id"\) </);
    // Always bounded in time, so the planner can prune monthly partitions.
    expect(sql).toMatch(/"created_at" >= /);
    expect(sql).toMatch(/"created_at" <= /);
  });
});

describe('clampAuditRange', () => {
  const now = new Date('2026-08-11T12:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;

  it('defaults to the widest permitted window ending now', () => {
    const window = clampAuditRange({}, now);
    expect(window.to).toEqual(now);
    expect(window.to.getTime() - window.from.getTime()).toBe(MAX_AUDIT_RANGE_DAYS * day);
  });

  it('leaves a narrow range untouched', () => {
    const from = new Date(now.getTime() - 7 * day);
    const window = clampAuditRange({ from, to: now }, now);
    expect(window).toEqual({ from, to: now });
  });

  it('clamps an over-wide range to the most recent slice', () => {
    const window = clampAuditRange({ from: new Date('2020-01-01T00:00:00.000Z'), to: now }, now);
    expect(window.to).toEqual(now);
    expect(window.from).toEqual(new Date(now.getTime() - MAX_AUDIT_RANGE_DAYS * day));
  });

  it('collapses an inverted range instead of guessing what was meant', () => {
    const to = new Date(now.getTime() - 30 * day);
    const window = clampAuditRange({ from: now, to }, now);
    expect(window.from).toEqual(to);
    expect(window.to).toEqual(to);
  });

  it('clamps a historic window backwards from the requested end, not from now', () => {
    const to = new Date('2026-03-01T00:00:00.000Z');
    const window = clampAuditRange({ from: new Date('2019-01-01T00:00:00.000Z'), to }, now);
    expect(window.to).toEqual(to);
    expect(window.from).toEqual(new Date(to.getTime() - MAX_AUDIT_RANGE_DAYS * day));
  });
});

describe('isIpAllowed', () => {
  it('allows any address when the allowlist is absent or empty', () => {
    expect(isIpAllowed(null, '203.0.113.5')).toBe(true);
    expect(isIpAllowed(undefined, '203.0.113.5')).toBe(true);
    expect(isIpAllowed([], '203.0.113.5')).toBe(true);
    // "No restriction" must hold even for input the parser would reject, so that
    // an unrestricted token is never denied by a parsing quirk.
    expect(isIpAllowed([], 'not-an-address')).toBe(true);
  });

  it('matches an exact IPv4 address', () => {
    expect(isIpAllowed(['203.0.113.5'], '203.0.113.5')).toBe(true);
    expect(isIpAllowed(['203.0.113.5'], '203.0.113.6')).toBe(false);
  });

  it('matches an IPv4 CIDR range on both sides of the boundary', () => {
    expect(isIpAllowed(['203.0.113.0/24'], '203.0.113.255')).toBe(true);
    expect(isIpAllowed(['203.0.113.0/24'], '203.0.114.1')).toBe(false);
    // A prefix that does not land on a byte boundary.
    expect(isIpAllowed(['10.0.0.0/12'], '10.15.255.1')).toBe(true);
    expect(isIpAllowed(['10.0.0.0/12'], '10.16.0.1')).toBe(false);
    // /0 permits everything, and /32 is an exact match.
    expect(isIpAllowed(['0.0.0.0/0'], '198.51.100.9')).toBe(true);
    expect(isIpAllowed(['198.51.100.9/32'], '198.51.100.9')).toBe(true);
    expect(isIpAllowed(['198.51.100.9/32'], '198.51.100.10')).toBe(false);
  });

  it('matches exact and CIDR IPv6, including compressed forms', () => {
    expect(isIpAllowed(['2001:db8::1'], '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isIpAllowed(['2001:db8::/32'], '2001:db8:abcd::9')).toBe(true);
    expect(isIpAllowed(['2001:db8::/32'], '2001:db9::9')).toBe(false);
    expect(isIpAllowed(['::1'], '::1')).toBe(true);
  });

  it('never matches across address families', () => {
    // Documented behaviour: an IPv4-mapped IPv6 address is not the IPv4 address.
    // Equating them would make an allowlist match something nobody wrote down.
    expect(isIpAllowed(['203.0.113.5'], '::ffff:203.0.113.5')).toBe(false);
    expect(isIpAllowed(['::ffff:203.0.113.5'], '203.0.113.5')).toBe(false);
    expect(isIpAllowed(['203.0.113.0/24'], '2001:db8::1')).toBe(false);
  });

  it('fails closed on malformed input', () => {
    expect(isIpAllowed(['203.0.113.0/24'], 'not-an-address')).toBe(false);
    expect(isIpAllowed(['203.0.113.0/24'], '203.0.113')).toBe(false);
    expect(isIpAllowed(['203.0.113.0/24'], '203.0.113.256')).toBe(false);
    // Ambiguous octal-looking octets are rejected rather than reinterpreted.
    expect(isIpAllowed(['203.0.113.5'], '203.0.113.05')).toBe(false);
    // A malformed entry simply never matches; it does not open the allowlist.
    expect(isIpAllowed(['garbage', '203.0.113.5'], '203.0.113.5')).toBe(true);
    expect(isIpAllowed(['garbage'], '203.0.113.5')).toBe(false);
    expect(isIpAllowed(['203.0.113.0/33'], '203.0.113.5')).toBe(false);
    expect(isIpAllowed(['203.0.113.0/'], '203.0.113.5')).toBe(false);
    // Zone identifiers are rejected rather than stripped.
    expect(isIpAllowed(['fe80::1'], 'fe80::1%eth0')).toBe(false);
    expect(isIpAllowed(['2001:db8:::1'], '2001:db8::1')).toBe(false);
  });
});
