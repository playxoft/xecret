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
 * The website, the privacy policy and the terms say that xecret cannot read
 * your secret values. That is true of every `e2ee` environment, which is every
 * environment created since migration 0013. It is **not** true of an
 * environment that migration backfilled to `server`: its values are still
 * encrypted under an `env_keys` row the Worker unwraps with the root key, and
 * `secrets-service.ts` still decrypts them. ADR 0009 gates the claim on exactly
 * this — "until the last environment is migrated … we can read *some* customer
 * secrets".
 *
 * So the claim holds on a deployment exactly when this report finds no live
 * secret in a server-mode environment. Soft-deleted ones count too: deleting an
 * environment or a secret leaves its ciphertext, and the key that opens it, in
 * place until the 30-day purge erases them.
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
  secrets_in_deleted_environments: string;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Try: phase run -- npm run check:server-encrypted');
    process.exit(1);
  }

  const { db, end } = createDatabaseHandle({ connectionString: url });

  try {
    const [row] = (await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE e.deleted_at IS NULL) AS live_environments,
        count(*) FILTER (WHERE e.deleted_at IS NOT NULL) AS deleted_environments,
        count(DISTINCT p.org_id) AS organisations,
        (
          SELECT count(*)
          FROM secrets s
          JOIN environments se ON se.id = s.environment_id
          WHERE se.encryption_mode = 'server'
            AND se.deleted_at IS NULL
            AND s.deleted_at IS NULL
        ) AS live_secrets,
        (
          SELECT count(*)
          FROM secrets s
          JOIN environments se ON se.id = s.environment_id
          WHERE se.encryption_mode = 'server'
            AND (se.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL)
        ) AS secrets_in_deleted_environments
      FROM environments e
      JOIN projects p ON p.id = e.project_id
      WHERE e.encryption_mode = 'server'
    `)) as unknown as ModeRow[];

    const live = Number(row?.live_environments ?? 0);
    const deleted = Number(row?.deleted_environments ?? 0);
    const secrets = Number(row?.live_secrets ?? 0);
    const buried = Number(row?.secrets_in_deleted_environments ?? 0);

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
    console.warn(`  deleted secrets in them:    ${buried}`);
    console.warn('');
    console.warn(
      'Until these are moved to new environments and purged, "xecret cannot read your secrets" is not true of them.',
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
