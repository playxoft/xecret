#!/usr/bin/env -S npx tsx
/**
 * Reports projects whose slug is shaped like a UUID.
 *
 *   phase run -- npm run check:uuid-slugs
 *
 * Read-only. Exits non-zero when it finds a live one, so a pre-deploy check
 * wired to it goes red on the state rather than printing it somewhere nobody
 * reads.
 *
 * ## Why such a slug matters now
 *
 * A project's address takes its id or its slug in the same segment —
 * `/app/{org}/{projectId}/…` in the dashboard, either one under
 * `/api/orgs/{org}/projects/` — and `resolveProject` tells them apart by shape:
 * a canonical lowercase UUID is an id, anything else a slug. `checkSlug` now
 * refuses a UUID-shaped slug at creation, so no new one can exist. Nothing
 * refused one before, though: a project *named* after a UUID would have been
 * slugged to it. Such a project still works wherever its slug is a reference —
 * a grant, the audit filter — but its address reads the slug as an id and
 * finds nothing, so the CLI and `.xecret.yaml` could not reach it by slug.
 *
 * That is why this is a check and not a migration. A slug is immutable and
 * sits in other people's CI configuration, so nothing here renames one; the
 * expected result is that it finds none, and if it ever does, the answer is a
 * decision for whoever owns the project, not a statement this script makes.
 *
 * ## Soft-deleted projects are reported too
 *
 * `restoreProject` brings one back with its slug, so a deleted project holding
 * a UUID-shaped slug is the same problem waiting for a restore. Listed, marked,
 * and not counted towards the exit status: nothing can reach it until then.
 *
 * The pattern is `isUuid`'s exactly — lowercase hex, 8-4-4-4-12 — matched in
 * SQL, because `slug` is `citext` and an uppercase spelling is no id the system
 * ever issues.
 */

import { sql } from 'drizzle-orm';
import { createDatabaseHandle } from '../packages/db/src/client.ts';

interface UuidShapedRow {
  org_id: string;
  project_id: string;
  project_slug: string;
  deleted: boolean;
}

const UUID_SHAPE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Try: phase run -- npm run check:uuid-slugs');
    process.exit(1);
  }

  const { db, end } = createDatabaseHandle({ connectionString: url });

  try {
    // `::text` before the match: `~` on a `citext` column is case-insensitive,
    // and the address is not — only the lowercase spelling is read as an id.
    const rows = (await db.execute(sql`
      SELECT
        o.id::text AS org_id,
        p.id AS project_id,
        p.slug AS project_slug,
        p.deleted_at IS NOT NULL AS deleted
      FROM projects p
      JOIN organizations o ON o.id = p.org_id
      WHERE p.slug::text ~ ${UUID_SHAPE}
      ORDER BY o.id, p.slug
    `)) as unknown as UuidShapedRow[];

    if (rows.length === 0) {
      console.warn('✅  No project slug is shaped like a UUID. Every address reads one way.');
      return;
    }

    for (const row of rows) {
      console.warn(
        `  ${row.org_id}/${row.project_slug}  (id ${row.project_id})${row.deleted ? '  (deleted)' : ''}`,
      );
    }

    const live = rows.filter((row) => !row.deleted);
    console.warn('');
    console.warn(
      `${rows.length} project(s) with a UUID-shaped slug, ${live.length} of them live. ` +
        'Their slug no longer addresses them; by id, they work as before.',
    );
    // `exitCode` rather than `process.exit`, so the `finally` closes the pool.
    if (live.length > 0) process.exitCode = 1;
  } finally {
    await end();
  }
}

main().catch((error: unknown) => {
  // The message, with any connection string scrubbed out of it — see
  // `check-unkeyed-environments.ts`.
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '<connection string redacted>'));
  process.exit(1);
});
