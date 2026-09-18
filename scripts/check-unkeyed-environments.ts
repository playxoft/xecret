#!/usr/bin/env -S npx tsx
/**
 * Reports environments that claim end-to-end encryption and hold no key.
 *
 *   phase run -- npx tsx scripts/check-unkeyed-environments.ts           # report
 *   phase run -- npx tsx scripts/check-unkeyed-environments.ts --apply   # retire
 *
 * ## The state this looks for
 *
 * An environment whose `encryption_mode` is `e2ee` but which has no row in
 * `env_data_keys`. Nothing can be written to it — every write path demands an
 * `env_data_key_id` that only a grant can supply — and nothing can repair it,
 * because the key bytes existed only in the browser that generated them and that
 * browser has long since navigated away. `env-key-notice.tsx` says exactly that
 * to the user, and tells them to create a new environment and delete this one.
 *
 * ## Why it is a standing check rather than a one-off
 *
 * `POST …/environments` and `POST …/projects` write the environment row and its
 * key rows in one transaction, precisely so this cannot arise. But the repair
 * endpoint at `POST …/environments/{envSlug}/keys` exists because it can anyway
 * — for "an environment that predates the creation flow, or one whose creation
 * was interrupted in a way the transaction could not roll back". That is a state
 * the system contemplates and has no way to notice on its own: nothing errors,
 * no alert fires, and the first person to find out is a user staring at a red
 * box in a project they cannot use.
 *
 * It has also happened once at scale. `provisionOrganization` used to seed each
 * new organisation with a `Default` project, inserting the environment rows
 * directly rather than through `createEnvironment`. Migration 0013 added
 * `encryption_mode`, backfilled every existing row to `server`, and then changed
 * the column *default* to `e2ee` — so from that deployment until the seeding was
 * removed, every organisation was born with three of these. No deployment
 * actually created one, which is the only reason this ships as a check instead
 * of as a migration.
 *
 * ## Why the predicate is never "the project is called default"
 *
 * Because most `Default` projects are **fine**. 0013 backfilled everything that
 * existed at the time to `server`, and a server-mode environment has a working
 * `env_keys` row, holds real secrets, and must not be touched. The name does not
 * distinguish the two. What distinguishes them is the thing that is missing:
 *
 *   encryption_mode = 'e2ee'  AND  no row in env_data_keys
 *
 * A project is retired only when *every* live environment in it matches, so one
 * that has since had a working environment added beside the broken ones is
 * reported and left alone.
 *
 * ## Why `--apply` deletes rather than relabels
 *
 * An environment seeded by the old provisioning path does still have a valid
 * server-mode `env_keys` row, so flipping `encryption_mode` back to `server`
 * would make it work — and it is the wrong fix twice over. It re-opens an
 * environment the server can read, after the product has told the user it
 * cannot; and the browser refuses it regardless, because the trust-on-first-use
 * mode pin only ever moves `server → e2ee` and reads the reverse as the
 * downgrade attack it is designed to catch. Every user who has opened one of
 * these holds that pin.
 *
 * ## Nothing that holds a secret is touched
 *
 * A keyless `e2ee` environment cannot have been written to, so `--apply` is
 * expected to find nothing in these projects. It asserts that rather than
 * assuming it, and refuses to retire anything that turns out to hold a live
 * secret — if that ever fires, the premise above is wrong and the run must stop.
 *
 * The delete is soft, like every other delete in this system. An audit record
 * pointing at a row somebody `DELETE`d is worthless.
 */

import { and, inArray, isNull, sql } from 'drizzle-orm';
import { createDatabaseHandle } from '../packages/db/src/client.ts';
import { projects } from '../packages/db/src/schema/resources.ts';

interface UnkeyedRow {
  org_id: string;
  org_slug: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  live_environments: number;
  unkeyed_environments: number;
  live_secrets: number;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Try: phase run -- npx tsx scripts/check-unkeyed-environments.ts',
    );
    process.exit(1);
  }

  const apply = process.argv.includes('--apply');
  const { db, end } = createDatabaseHandle({ connectionString: url });

  try {
    /**
     * One statement, per project, counting three things side by side: how many
     * live environments it has, how many of those are keyless, and how many live
     * secrets sit anywhere inside it.
     *
     * Counting the secrets here rather than in a follow-up query is what makes
     * the safety check unracy with the report — the number printed and the
     * number decided on are the same number.
     */
    const rows = (await db.execute(sql`
      SELECT
        o.id   AS org_id,
        o.slug AS org_slug,
        p.id   AS project_id,
        p.slug AS project_slug,
        p.name AS project_name,
        count(e.id)                                        AS live_environments,
        count(e.id) FILTER (WHERE k.environment_id IS NULL) AS unkeyed_environments,
        coalesce(sum(s.live_secrets), 0)                    AS live_secrets
      FROM projects p
      JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
      JOIN environments e ON e.project_id = p.id AND e.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT 1 AS environment_id
        FROM env_data_keys d
        WHERE d.environment_id = e.id
        LIMIT 1
      ) k ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS live_secrets
        FROM secrets x
        WHERE x.environment_id = e.id AND x.deleted_at IS NULL
      ) s ON true
      WHERE p.deleted_at IS NULL
        AND e.encryption_mode = 'e2ee'
      GROUP BY o.id, o.slug, p.id, p.slug, p.name
      HAVING count(e.id) FILTER (WHERE k.environment_id IS NULL) > 0
      ORDER BY o.slug, p.slug
    `)) as unknown as UnkeyedRow[];

    if (rows.length === 0) {
      console.warn('✅  No keyless environments. Nothing to repair.');
      return;
    }

    // Wholly broken: every live environment in the project is keyless, so there
    // is nothing in it worth keeping and retiring the project hides all of them
    // through the join rule, with one write.
    const retirable = rows.filter(
      (row) => Number(row.unkeyed_environments) === Number(row.live_environments),
    );
    const partial = rows.filter(
      (row) => Number(row.unkeyed_environments) !== Number(row.live_environments),
    );
    const holdingSecrets = retirable.filter((row) => Number(row.live_secrets) > 0);

    for (const row of rows) {
      const shape =
        Number(row.unkeyed_environments) === Number(row.live_environments)
          ? 'all keyless'
          : `${row.unkeyed_environments} of ${row.live_environments} keyless`;
      console.warn(`  ${row.org_slug}/${row.project_slug}  "${row.project_name}"  — ${shape}`);
    }

    console.warn('');
    console.warn(`${rows.length} affected project(s): ${retirable.length} wholly keyless.`);

    if (partial.length > 0) {
      console.warn(
        `⚠️   ${partial.length} project(s) have working environments beside the keyless ones — ` +
          'left alone. Delete the individual environments in the dashboard.',
      );
    }

    // The premise, checked rather than assumed. A keyless e2ee environment has
    // no write path, so this is expected to be empty; if it is not, something
    // about the failure is not understood and nothing should be deleted.
    if (holdingSecrets.length > 0) {
      console.error('');
      console.error(
        `❌  ${holdingSecrets.length} keyless project(s) hold live secrets, which should be ` +
          'impossible. Refusing to delete anything. Investigate before re-running:',
      );
      for (const row of holdingSecrets) {
        console.error(`    ${row.org_slug}/${row.project_slug} — ${row.live_secrets} secret(s)`);
      }
      process.exit(1);
    }

    if (!apply) {
      console.warn('');
      console.warn('Dry run. Re-run with --apply to retire the wholly keyless projects.');
      return;
    }

    // Soft, and in one statement: the set was computed above and a row that
    // became keyed in between would no longer match `deleted_at is null` twice.
    const ids = retirable.map((row) => row.project_id);
    if (ids.length === 0) {
      console.warn('Nothing wholly keyless to retire.');
      return;
    }

    // Through the query builder rather than interpolated into a string. These
    // ids came from the database a moment ago and are uuids, so nothing hostile
    // is in play — but a `sql.raw` holding a joined list is the shape that stops
    // being safe the first time somebody feeds this script an id from elsewhere.
    const retired = await db
      .update(projects)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(projects.id, ids), isNull(projects.deletedAt)))
      .returning({ id: projects.id });

    console.warn('');
    console.warn(`✅  Retired ${retired.length} project(s). Their slugs are free to reuse.`);
    console.warn('    Affected users create a new project from the dashboard, which now works.');
  } finally {
    await end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
