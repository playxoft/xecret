#!/usr/bin/env -S npx tsx
/**
 * Reports environments still on server-side encryption, and the secrets they hold.
 *
 *   phase run --env Production -- npm run check:server-encrypted
 *
 * Read-only. Prints counts and nothing else — no organisation, project or
 * secret name — so its output can be pasted into a pull request.
 *
 * ## Why this exists
 *
 * The website says that xecret cannot read your secret values. That is true of
 * every `e2ee` environment, which is every environment created since migration
 * 0013. It is **not** true of an environment that migration backfilled to
 * `server`: its values are still encrypted under an `env_keys` row the Worker
 * unwraps with the root key, and `secrets-service.ts` still decrypts them. The
 * privacy policy and the terms state that exception; this report says whether
 * anybody is still in it.
 *
 * ADR 0009 gates the unqualified claim on two things: no environment left in
 * server mode, and the envelope decrypt path deleted. This answers the first
 * only. A clean run means no stored value is one the server can open; the
 * server-mode code path still exists until it is removed.
 *
 * ## Live, and awaiting purge
 *
 * An environment is live only when it, its project and its organisation are
 * all undeleted: deleting a project or an organisation marks only that row, so
 * an environment inside one keeps a null `deleted_at` (the same shape
 * `check-unkeyed-environments.ts` relies on). Deleted ones are counted too,
 * because a soft delete leaves the ciphertext and the key that opens it in
 * place until the purge erases them — 30 days after the delete, or, for a secret
 * deleted from an environment that still exists, at the end of its
 * organisation's point-in-time restore window if that is longer
 * (`deletedSecretRetentionDays`).
 *
 * ## What to do about a hit
 *
 * An environment cannot be switched over in place (`environment-key-card.tsx`
 * says so to anybody who opens one). Its owner creates a new environment, moves
 * the values across from the dashboard, and deletes the old one; the purge then
 * erases it. Exits non-zero while anything is left, so a CI job wired to it goes
 * red on the state rather than reporting it into a log nobody reads.
 */

import { sql } from 'drizzle-orm';
import { createDatabaseHandle } from '../packages/db/src/client.ts';

interface ModeRow {
  // `string`, not `number`: postgres.js hands back `count()` — an `int8` — as a
  // string. See `check-unkeyed-environments.ts` for why that is kept honest.
  live_environments: string;
  deleted_environments: string;
  organisations: string;
  live_secrets: string;
  deleted_secrets: string;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    // `--env Production` spelled out: the default Phase environment is
    // development, where a clean run proves nothing about the live service.
    console.error(
      'DATABASE_URL is not set. Try: phase run --env Production -- npm run check:server-encrypted',
    );
    process.exit(1);
  }

  const { db, end } = createDatabaseHandle({ connectionString: url });

  try {
    const [row] = (await db.execute(sql`
      WITH server_envs AS (
        SELECT
          e.id,
          p.org_id,
          (e.deleted_at IS NULL AND p.deleted_at IS NULL AND o.deleted_at IS NULL) AS live
        FROM environments e
        JOIN projects p ON p.id = e.project_id
        JOIN organizations o ON o.id = p.org_id
        WHERE e.encryption_mode = 'server'
      )
      SELECT
        (SELECT count(*) FROM server_envs WHERE live) AS live_environments,
        (SELECT count(*) FROM server_envs WHERE NOT live) AS deleted_environments,
        (SELECT count(DISTINCT org_id) FROM server_envs) AS organisations,
        (
          SELECT count(*) FROM secrets s JOIN server_envs se ON se.id = s.environment_id
          WHERE se.live AND s.deleted_at IS NULL
        ) AS live_secrets,
        (
          SELECT count(*) FROM secrets s JOIN server_envs se ON se.id = s.environment_id
          WHERE NOT se.live OR s.deleted_at IS NOT NULL
        ) AS deleted_secrets
    `)) as unknown as ModeRow[];

    const live = Number(row?.live_environments ?? 0);
    const deleted = Number(row?.deleted_environments ?? 0);
    const secrets = Number(row?.live_secrets ?? 0);
    const buried = Number(row?.deleted_secrets ?? 0);

    if (live + deleted === 0) {
      console.warn(
        '✅  No server-encrypted environments. Every stored value is end-to-end encrypted.',
      );
      return;
    }

    console.warn('Server-encrypted environments (values the server can decrypt):');
    console.warn(`  live environments:          ${live}`);
    console.warn(`  deleted, awaiting purge:    ${deleted}`);
    console.warn(`  organisations:              ${Number(row?.organisations ?? 0)}`);
    console.warn(`  live secrets in them:       ${secrets}`);
    console.warn(`  deleted, awaiting purge:    ${buried}`);
    console.warn('');
    console.warn(
      'Until these are moved to new environments and purged, the server can decrypt the values in them.',
    );
    process.exitCode = 1;
  } finally {
    await end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // postgres.js can echo the connection string in a connection error.
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '<connection string redacted>'));
  process.exit(1);
});
