import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import type { AccessLevel } from '@xecret/core/authz';
import * as schema from '../schema';
import type { Database } from '../client';
import { applyInitialGrants } from './invitations';

/**
 * What an invitation's access selection becomes at acceptance.
 *
 * ── Why these rows are a contract rather than an implementation detail ──
 * Nothing else in the product decides who can reach what at the moment somebody
 * joins, and one other place has to *predict* the answer: `invitationReaches` in
 * the web app runs the same rule before anybody accepts, so that an environment
 * key can be sealed to an invitation the invitee will actually be entitled to.
 * The two must be one decision. These tests pin this half of it; the tests in
 * `apps/web/src/server/env-keys.test.ts` pin the other, against the same cases.
 *
 * ── The finding ──
 * A selected environment's row was skipped whenever its project also carried a
 * whole-project selection, on the reasoning that the project row already covered
 * it. That reasoning stopped holding the moment the two levels became separately
 * selectable: an inviter granting a project at `read` and carving production
 * back to `none` had the carve-out silently discarded, and the invitee joined
 * with production access nobody chose to give them.
 *
 * ── What these are and are not ──
 * Shape tests, like the rest of this directory: the driver is a recorder, no
 * PostgreSQL runs, and the assertions are about the rows the planner *asks* to
 * insert. That nothing else can write a conflicting row is a property of
 * `access_grants_unique_idx`, asserted structurally in `schema.test.ts`.
 */

const ORG_ID = '01930000-0000-7000-8000-000000000001';
const MEMBER_ID = '01930000-0000-7000-8000-000000000002';
const INVITER_ID = '01930000-0000-7000-8000-000000000003';
const PROJECT_ID = '01930000-0000-7000-8000-000000000004';
const OTHER_PROJECT_ID = '01930000-0000-7000-8000-000000000005';
const PRODUCTION_ID = '01930000-0000-7000-8000-000000000006';
const STAGING_ID = '01930000-0000-7000-8000-000000000007';

interface RecordedStatement {
  sql: string;
  params: readonly unknown[];
}

/**
 * The recorder `key-arithmetic.test.ts` uses, with the two reads this planner
 * makes on its way to the insert: the organisation's live projects, and the
 * selected environments verified live and in-tenant.
 *
 * The environment read answers with the ids the seeds actually named, because
 * the real statement narrows on exactly those — a recorder that returned the
 * whole project would make every test look as though an unselected environment
 * had been seeded.
 */
function recorder(selected: readonly string[] = []): {
  db: Database;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  const live: Readonly<Record<string, string>> = {
    [PRODUCTION_ID]: PROJECT_ID,
    [STAGING_ID]: PROJECT_ID,
  };

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: readonly unknown[]) {
      statements.push({ sql, params });

      const rows = sql.includes('from "projects"')
        ? [[PROJECT_ID], [OTHER_PROJECT_ID]]
        : sql.includes('from "environments"')
          ? selected.filter((id) => id in live).map((id) => [id, live[id] as string])
          : [];

      const result = Promise.resolve(rows) as Promise<unknown[]> & {
        values: () => Promise<unknown[]>;
      };
      result.values = () => Promise.resolve(rows);
      return result;
    },
    begin: <T>(run: (client: unknown) => Promise<T>) => run(client),
    savepoint: <T>(run: (client: unknown) => Promise<T>) => run(client),
  };

  return { db: drizzle(client as unknown as Sql, { schema }), statements };
}

/** One planned `access_grants` row, read back out of the insert's parameters. */
interface PlannedRow {
  projectId: string;
  environmentId: string | null;
  accessLevel: AccessLevel;
}

/**
 * The rows the insert would write.
 *
 * Read positionally out of the bound parameters, because that is all a recorder
 * sees. The column order is the one `applyInitialGrants` builds: id, member,
 * project, environment, level, granter, created, updated — eight per row.
 */
function planned(statements: RecordedStatement[]): PlannedRow[] {
  const insert = statements.find((statement) =>
    statement.sql.startsWith('insert into "access_grants"'),
  );
  if (insert === undefined) return [];

  const rows: PlannedRow[] = [];
  for (let at = 0; at + 7 < insert.params.length; at += 8) {
    rows.push({
      projectId: insert.params[at + 2] as string,
      environmentId: insert.params[at + 3] as string | null,
      accessLevel: insert.params[at + 4] as AccessLevel,
    });
  }
  return rows;
}

async function plan(
  seeds: { projectId: string; environmentId: string | null; accessLevel?: AccessLevel }[],
  role: 'admin' | 'developer' | 'viewer' = 'developer',
) {
  const { db, statements } = recorder(
    seeds.map((seed) => seed.environmentId).filter((id): id is string => id !== null),
  );

  const counts = await applyInitialGrants(db, {
    orgId: ORG_ID,
    memberId: MEMBER_ID,
    role,
    grantedBy: INVITER_ID,
    seeds,
  });

  return { counts, rows: planned(statements) };
}

describe('the rows an invitation’s selection becomes', () => {
  it('denies every project the selection did not name', async () => {
    // Deny-by-default, and it covers a project created between the invitation
    // and its acceptance: the row is written for whatever the organisation has
    // *now*, not for what it had when the invitation was written.
    const { rows } = await plan([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
    ]);

    expect(rows).toContainEqual({
      projectId: OTHER_PROJECT_ID,
      environmentId: null,
      accessLevel: 'none',
    });
  });

  it('writes a named environment’s own level beside its project’s', async () => {
    // ── The finding ──
    // This row used to be skipped whenever the project carried a whole-project
    // seed, so the carve-out below was discarded and the invitee arrived holding
    // production at `read`.
    const { rows } = await plan([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' },
    ]);

    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: null,
      accessLevel: 'read',
    });
    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ID,
      accessLevel: 'none',
    });
  });

  it('writes a restating row rather than reasoning about redundancy', async () => {
    // Identical levels are the case where skipping was harmless, and it is still
    // written: `resolveAccessLevel` gives the specific row precedence either
    // way, and one rule with no exception is what keeps this function and
    // `invitationReaches` in step.
    const { rows } = await plan([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'write' },
      { projectId: PROJECT_ID, environmentId: STAGING_ID, accessLevel: 'write' },
    ]);

    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: STAGING_ID,
      accessLevel: 'write',
    });
  });

  it('honours a level of none on an environment of an otherwise-denied project', async () => {
    const { rows } = await plan([
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' },
    ]);

    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: null,
      accessLevel: 'none',
    });
    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ID,
      accessLevel: 'none',
    });
  });

  it('falls back to the invited role’s non-production level for a seed with no level', async () => {
    // Every seed written before the invite dialog offered levels has this shape.
    // A `developer` selecting production this way gets `write` there, because the
    // selection itself is the consent the production default withholds.
    const { rows } = await plan([
      { projectId: PROJECT_ID, environmentId: null },
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID },
    ]);

    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: null,
      accessLevel: 'write',
    });
    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ID,
      accessLevel: 'write',
    });
  });

  it('reads the fallback from the invited role, not from a fixed level', async () => {
    const { rows } = await plan([{ projectId: PROJECT_ID, environmentId: STAGING_ID }], 'viewer');

    expect(rows).toContainEqual({
      projectId: PROJECT_ID,
      environmentId: STAGING_ID,
      accessLevel: 'read',
    });
  });

  it('counts what the member ends up holding, not the rows it wrote', async () => {
    // One project granted, one denied, and a restating environment row that
    // changes nothing — so it is neither a grant nor a denial of its own.
    const { counts } = await plan([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT_ID, environmentId: STAGING_ID, accessLevel: 'read' },
    ]);

    expect(counts).toEqual({ granted: 1, denied: 1 });
  });

  it('counts a carve-out as the denial it is', async () => {
    const { counts } = await plan([
      { projectId: PROJECT_ID, environmentId: null, accessLevel: 'read' },
      { projectId: PROJECT_ID, environmentId: PRODUCTION_ID, accessLevel: 'none' },
    ]);

    expect(counts).toEqual({ granted: 1, denied: 2 });
  });

  it('verifies selected environments through their project’s organisation', async () => {
    // A seed cannot smuggle in an environment id from another tenant: the read
    // that resolves them joins projects on this organisation (threat T2).
    const { db, statements } = recorder([PRODUCTION_ID]);

    await applyInitialGrants(db, {
      orgId: ORG_ID,
      memberId: MEMBER_ID,
      role: 'developer',
      grantedBy: INVITER_ID,
      seeds: [{ projectId: PROJECT_ID, environmentId: PRODUCTION_ID }],
    });

    const read = statements.find((statement) => statement.sql.includes('from "environments"'));
    expect(read!.sql).toContain('inner join "projects"');
    expect(read!.sql).toContain('"projects"."org_id" = $');
    expect(read!.params).toContain(ORG_ID);
  });
});
