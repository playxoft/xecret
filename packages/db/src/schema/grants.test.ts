import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import * as schema from './index';

/**
 * Every table the application uses is usable by the application's role, after
 * every migration — the check whose absence let migration 0019 ship a table
 * the production role could not read.
 *
 * The production database runs the app as `xecret_app_permissions` (0002/0003),
 * which holds no DDL rights and, since 0010 revoked the default privileges, is
 * granted nothing on a new table automatically. Each migration that creates a
 * table therefore ends with a guarded GRANT, and forgetting it is invisible in
 * every test that runs as the superuser — which is all of them, until this one.
 * Here the role exists (0002 creates it in the test database too), so the
 * guards fire, and the privileges are read back from the catalogue.
 *
 * Tables are taken from the Drizzle schema, not from the catalogue, so a table
 * the code declares but no migration grants is caught by name.
 */

const ROLE = 'xecret_app_permissions';

/**
 * Append-only by design: the role may read and add rows, never change or
 * remove them. Listed here so that losing the restriction fails too.
 */
const APPEND_ONLY = new Set(['audit_logs', 'billing_webhook_events']);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

function declaredTables(): string[] {
  return Object.values(schema)
    .filter((value): value is PgTable => {
      try {
        return typeof getTableConfig(value as PgTable).name === 'string';
      } catch {
        return false;
      }
    })
    .map((table) => getTableConfig(table).name)
    .sort();
}

async function privileges(table: string) {
  const result = await t.pg.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
    `select has_table_privilege($1, c.oid, 'SELECT') as s,
            has_table_privilege($1, c.oid, 'INSERT') as i,
            has_table_privilege($1, c.oid, 'UPDATE') as u,
            has_table_privilege($1, c.oid, 'DELETE') as d
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $2`,
    [ROLE, table],
  );
  return result.rows[0];
}

describe('the application role', () => {
  it('exists after the migrations, so the guarded grants actually ran', async () => {
    const result = await t.pg.query(`select 1 from pg_roles where rolname = $1`, [ROLE]);
    expect(result.rows).toHaveLength(1);
  });

  it('is declared at least one table per migration-era module (sanity)', () => {
    expect(declaredTables()).toEqual(expect.arrayContaining(['users', 'reauthentications']));
  });

  it.each(declaredTables())('may use %s', async (table) => {
    const granted = await privileges(table);

    expect(granted, `${table} is declared in the schema but not in the database`).toBeDefined();
    expect(granted).toEqual(
      APPEND_ONLY.has(table)
        ? { s: true, i: true, u: false, d: false }
        : { s: true, i: true, u: true, d: true },
    );
  });
});
