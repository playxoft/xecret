#!/usr/bin/env -S npx tsx
/**
 * Proves that the application's database role is actually restricted.
 *
 *   phase run -- npx tsx scripts/check-db-role.ts
 *
 * Migration 0002 claims three things: the application role cannot run DDL, it
 * cannot modify `audit_logs`, and it can do ordinary tenant work. Those claims
 * are grants in a file — this script is what turns them into an observation.
 *
 * It exists because the failure mode is silent. A role that was created through
 * a managed provider's console UI, or that inherited a superuser-adjacent role
 * from somewhere, looks identical in every application log right up until the
 * moment somebody needs the audit trail and finds it editable. `docs/operations/
 * database-setup.md` asks the operator to check this by hand; asking is weaker
 * than checking, so this does it.
 *
 * Every destructive probe runs inside a transaction that is always rolled back.
 * Running this against production is safe, and running it there is the point —
 * production is where the answer matters.
 */

import postgres from 'postgres';

/** The group role that carries the restricted grants. See migration 0002. */
const APP_GROUP_ROLE = 'xecret_app';

/**
 * Roles that would defeat the restriction if the application role held one.
 *
 * `neon_superuser` is Neon's; the others are common equivalents elsewhere. This
 * is a list of things seen in the wild, not an exhaustive one — which is why
 * the behavioural probes below matter more than this check does.
 */
const DANGEROUS_ROLES = [
  'neon_superuser',
  'rds_superuser',
  'cloudsqlsuperuser',
  'pg_write_all_data',
];

interface Check {
  name: string;
  /** What a correctly restricted role does. */
  expectation: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, expectation: string, passed: boolean, detail: string): void {
  checks.push({ name, expectation, passed, detail });
}

/**
 * Strips credentials from anything on its way to the terminal.
 *
 * postgres.js embeds the connection string in some connection errors, and this
 * script's whole audience is people who will paste its output into a chat
 * window when it fails.
 */
function safe(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '<connection string redacted>');
}

function describe(error: unknown): string {
  return safe(error instanceof Error ? error.message : 'unknown error');
}

/**
 * The username from a connection string, without parsing the password.
 *
 * `URL` handles the percent-encoding that a generated password will contain.
 * Returns null rather than throwing on a malformed value — a bad URL is the
 * connection's problem to report, with a better message than this could give.
 */
function roleFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const username = new URL(url).username;
    return username === '' ? null : decodeURIComponent(username);
  } catch {
    return null;
  }
}

/**
 * Runs a statement that MUST be refused, inside a transaction that is always
 * rolled back — so a role that wrongly succeeds still changes nothing.
 */
async function expectRefused(sql: postgres.Sql, name: string, statement: string): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(statement);
      // Reached only when the database allowed it. Undo it, then report.
      throw new PermittedError();
    });
    record(name, 'refused', false, 'the statement was ALLOWED');
  } catch (error) {
    if (error instanceof PermittedError) {
      record(name, 'refused', false, 'the statement was ALLOWED (rolled back)');
      return;
    }
    const message = describe(error);
    // 42501 is insufficient_privilege — the answer we want.
    const denied = /permission denied|must be owner|insufficient/i.test(message);
    record(name, 'refused', denied, denied ? 'refused, as intended' : message);
  }
}

class PermittedError extends Error {
  constructor() {
    super('statement permitted');
    this.name = 'PermittedError';
  }
}

async function expectAllowed(sql: postgres.Sql, name: string, statement: string): Promise<void> {
  try {
    await sql.unsafe(statement);
    record(name, 'allowed', true, 'succeeded, as intended');
  } catch (error) {
    record(name, 'allowed', false, describe(error));
  }
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];

  if (!url) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'This must be the APPLICATION role, not the migration owner — the point is to\n' +
        'prove the application cannot do what it must not do.\n\n' +
        'Try:  phase run -- npx tsx scripts/check-db-role.ts',
    );
    process.exit(1);
  }

  // Compared by ROLE, not by string. The two URLs commonly differ in their host
  // (pooled vs direct) or query parameters while naming the same user — which
  // looks like two configurations and behaves like one. That is the exact
  // mistake this catches, and a string comparison sails straight past it.
  const appRole = roleFromUrl(url);
  const migrationRole = roleFromUrl(process.env['MIGRATION_DATABASE_URL']);

  if (appRole !== null && appRole === migrationRole) {
    console.error(
      `DATABASE_URL connects as "${appRole}" — the same role as MIGRATION_DATABASE_URL.\n\n` +
        'The application would run as the migration owner, which can drop every table and\n' +
        'erase the audit log. The two URLs may look different (pooled vs direct endpoint,\n' +
        'different query parameters) while naming the same user.\n\n' +
        'Fix: point DATABASE_URL at the restricted login role.\n' +
        'See docs/operations/database-setup.md §3.',
    );
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const [identity] = await sql<{ user: string; superuser: boolean }[]>`
      SELECT current_user AS user, rolsuper AS superuser
      FROM pg_roles WHERE rolname = current_user
    `;

    console.warn(`\nConnected as: ${identity?.user ?? 'unknown'}\n`);

    record(
      'is not a PostgreSQL superuser',
      'false',
      identity?.superuser === false,
      identity?.superuser === true ? 'THIS ROLE IS A SUPERUSER' : 'not a superuser',
    );

    const memberships = await sql<{ rolname: string }[]>`
      SELECT r.rolname
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = current_user
    `;

    const held = memberships.map((row) => row.rolname);
    console.warn(`Member of: ${held.length > 0 ? held.join(', ') : '(nothing)'}\n`);

    record(
      `is a member of ${APP_GROUP_ROLE}`,
      'yes',
      held.includes(APP_GROUP_ROLE),
      held.includes(APP_GROUP_ROLE)
        ? 'inherits the restricted grants'
        : `NOT a member — run: GRANT ${APP_GROUP_ROLE} TO ${identity?.user ?? '<role>'};`,
    );

    const dangerous = held.filter((role) => DANGEROUS_ROLES.includes(role));
    record(
      'holds no privilege-escalating role',
      'none',
      dangerous.length === 0,
      dangerous.length === 0 ? 'none held' : `HOLDS ${dangerous.join(', ')}`,
    );

    // ── The behavioural probes. These are the ones that actually matter: they
    // ── test what the database does, not what its catalogue says it should.
    await expectRefused(
      sql,
      'cannot create a table (no DDL)',
      'CREATE TABLE _xecret_probe (id int)',
    );
    // ALTER rather than DROP: `DROP TABLE organizations` is refused by foreign
    // keys before permissions are ever consulted, so it reports a dependency
    // error whatever the role's rights are — a probe that cannot fail correctly
    // is not a probe. Adding a column touches nothing and needs table ownership.
    await expectRefused(
      sql,
      'cannot alter a table (no DDL)',
      'ALTER TABLE organizations ADD COLUMN _xecret_probe int',
    );
    await expectRefused(sql, 'cannot delete an audit record', 'DELETE FROM audit_logs');
    await expectRefused(sql, 'cannot alter an audit record', "UPDATE audit_logs SET action = 'x'");
    await expectRefused(sql, 'cannot truncate the audit log', 'TRUNCATE audit_logs');

    await expectAllowed(sql, 'can read tenant data', 'SELECT count(*) FROM organizations');
    await expectAllowed(sql, 'can read the audit log', 'SELECT count(*) FROM audit_logs');
    await expectAllowed(sql, 'can write tenant data', 'SELECT count(*) FROM secrets');
  } finally {
    await sql.end();
  }

  const width = Math.max(...checks.map((check) => check.name.length));
  let failed = 0;

  for (const check of checks) {
    if (!check.passed) failed += 1;
    const mark = check.passed ? '✅' : '❌';
    console.warn(`${mark}  ${check.name.padEnd(width)}  ${check.detail}`);
  }

  if (failed > 0) {
    console.error(
      `\n${failed} check(s) failed. This role is NOT safe to run the application with.\n` +
        'Do not store a real secret until every line above is green.\n' +
        'See docs/operations/database-setup.md.',
    );
    process.exit(1);
  }

  console.warn('\nAll checks passed. The application role is restricted as designed.\n');
}

main().catch((error: unknown) => {
  console.error('\nCould not complete the check:', describe(error));
  process.exit(1);
});
