import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
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
 * the code declares but no migration grants is caught by name. And the two are
 * compared the other way too: a table a migration creates that the schema does
 * not declare would otherwise never be checked here at all.
 */

const ROLE = 'xecret_app_permissions';

/**
 * Append-only by design: the role may read and add rows, never change or
 * remove them. Listed here so that losing the restriction fails too.
 */
const APPEND_ONLY = new Set(['audit_logs', 'billing_webhook_events']);

/**
 * Narrower still, by design (migration 0020): a retained vault's wraps and
 * grants are only ever inserted, and go with their vault by the foreign key's
 * cascade, which runs as the owner. The vault itself may be read, inserted and
 * deleted — the purge — and updated only in its three bookkeeping columns,
 * which is a column privilege and therefore not a table-wide UPDATE.
 */
const INSERT_ONLY = new Set(['retained_vault_wraps', 'retained_vault_grants']);
const NO_TABLE_UPDATE = new Set(['retained_vaults']);

/**
 * Read-only, by design (migration 0023): which WorkOS environment the database
 * belongs to is an operator's record, and the application that is checked
 * against it must not be able to rewrite it.
 */
const READ_ONLY = new Set(['workos_home']);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

function declaredTables(): string[] {
  const values: unknown[] = Object.values(schema);
  return values
    .filter((value): value is PgTable => is(value, PgTable))
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

  it('is checked against the tables the schema declares, reauthentications among them', () => {
    expect(declaredTables()).toEqual(expect.arrayContaining(['users', 'reauthentications']));
  });

  it('is checked against every table the migrations leave in public, none undeclared', async () => {
    const result = await t.pg.query<{ name: string }>(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
        order by c.relname`,
    );

    expect(result.rows.map((row) => row.name)).toEqual(declaredTables());
  });

  it.each(declaredTables())('may use %s', async (table) => {
    const granted = await privileges(table);

    expect(granted, `${table} is declared in the schema but not in the database`).toBeDefined();
    expect(granted).toEqual(
      READ_ONLY.has(table)
        ? { s: true, i: false, u: false, d: false }
        : APPEND_ONLY.has(table) || INSERT_ONLY.has(table)
          ? { s: true, i: true, u: false, d: false }
          : NO_TABLE_UPDATE.has(table)
            ? { s: true, i: true, u: false, d: true }
            : { s: true, i: true, u: true, d: true },
    );
  });

  it('may update exactly the bookkeeping columns of a retained vault', async () => {
    const result = await t.pg.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = $1 and table_name = 'retained_vaults' and privilege_type = 'UPDATE'
        order by column_name`,
      [ROLE],
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'recovered_at',
      'recovery_failed_attempts',
      'recovery_locked_until',
    ]);
  });
});
