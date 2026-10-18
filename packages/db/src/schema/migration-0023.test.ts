import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';

/**
 * Migration 0023's repair of 0022's `NOT VALID` link check, replayed against
 * the row it exists for (review round 2).
 *
 * 0022 added `organizations_workos_link_client_check` NOT VALID, so a linked
 * row with no `workos_client_id` would not stop the migration. But Postgres
 * checks a NOT VALID constraint on every UPDATE of a row, so such a row could
 * not be renamed, soft-deleted or have a policy switched off. 0023 backfills it
 * and validates the constraint. Every migration has already run on this
 * database, so the test puts the 0022 state back — the constraint NOT VALID,
 * one violating row — and then runs 0023's own two statements, read out of
 * the migration file, so what is tested is what ships.
 */

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0023_sso_workos_home.sql', import.meta.url),
);
const PRODUCTION_CLIENT_ID = 'client_01M36CECX3Z66Q2FYY2FN8WG73';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

/** The statements of 0023 that touch `organizations`, as the migrator splits them. */
function repairStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => /"organizations"/.test(statement));
}

describe('migration 0023, the link check', () => {
  it('backfills a linked organisation with no client id, then validates the constraint', async () => {
    const founder = randomUUID();
    await t.pg.query(`insert into users (id, firebase_uid, email) values ($1, $2, $3)`, [
      founder,
      `fb-${founder}`,
      `founder-${founder.slice(0, 8)}@example.com`,
    ]);

    // The state 0022 left on a database with a pre-release link.
    await t.pg.query(
      `alter table organizations drop constraint organizations_workos_link_client_check`,
    );
    const orgId = randomUUID();
    await t.pg.query(
      `insert into organizations (id, name, slug, created_by, workos_org_id)
       values ($1, 'Acme', $2, $3, 'org_01PRERELEASE')`,
      [orgId, `acme-${orgId.slice(0, 8)}`, founder],
    );
    await t.pg.query(
      `alter table organizations add constraint organizations_workos_link_client_check
         check (workos_org_id is null or workos_client_id is not null) not valid`,
    );

    // What 0022 did to that row: every UPDATE of it fails, even a rename.
    await expect(
      t.pg.query(`update organizations set name = 'Renamed' where id = $1`, [orgId]),
    ).rejects.toMatchObject({ code: '23514' });

    const statements = repairStatements();
    expect(statements).toHaveLength(2);
    for (const statement of statements) await t.pg.exec(statement);

    const row = await t.pg.query<{ workos_client_id: string | null }>(
      `select workos_client_id from organizations where id = $1`,
      [orgId],
    );
    expect(row.rows).toEqual([{ workos_client_id: PRODUCTION_CLIENT_ID }]);
    const constraint = await t.pg.query<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname = 'organizations_workos_link_client_check'`,
    );
    expect(constraint.rows).toEqual([{ convalidated: true }]);

    // And the row is an ordinary row again.
    await t.pg.query(`update organizations set name = 'Renamed' where id = $1`, [orgId]);
  });
});
