#!/usr/bin/env -S npx tsx
/**
 * Root KEK rotation.
 *
 * Re-wraps every organisation's master key from one Root KEK version to another.
 * No secret ciphertext is read, decrypted, or rewritten — that is the entire
 * point of the key hierarchy, and it is why rotating the root is cheap enough to
 * do on a schedule rather than only after an incident.
 *
 *   phase run -- npx tsx scripts/rotate-root-key.ts --from 1 --to 2 --dry-run
 *   phase run -- npx tsx scripts/rotate-root-key.ts --from 1 --to 2
 *
 * Prerequisites — the script refuses to run otherwise:
 *   · XECRET_ROOT_KEYS contains BOTH versions.
 *   · A database backup has been taken.
 *
 * Afterwards, in this order:
 *   1. Confirm zero rows remain on the old version (re-run with --dry-run).
 *   2. Set XECRET_ROOT_KEY_VERSION to the new version and deploy.
 *   3. Remove the old version from XECRET_ROOT_KEYS.
 *   4. Keep the old key's escrow shares for 90 days in case a stale backup must
 *      be restored, then destroy them and record it in key-recovery.md §7.
 */

import { eq, and } from 'drizzle-orm';
import { createDatabase, orgKeys } from '../packages/db/src/index.ts';
import { keyProviderFromEnv, rewrapOrgKey } from '../packages/core/src/crypto/index.ts';
import type { WrappedOrgKey } from '../packages/core/src/crypto/index.ts';

interface Options {
  from: number;
  to: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let from = Number.NaN;
  let to = Number.NaN;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--from':
        from = Number(argv[++i]);
        break;
      case '--to':
        to = Number(argv[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error('Both --from and --to are required, e.g. --from 1 --to 2');
  }
  if (from === to) {
    throw new Error('--from and --to must differ');
  }

  return { from, to, dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'No database URL. Secrets come from Phase.dev — try:\n' +
        '  phase run -- npx tsx scripts/rotate-root-key.ts --from 1 --to 2',
    );
  }

  // Fails loudly here if either version is missing, before touching a single row.
  const keys = keyProviderFromEnv(process.env);
  const oldRootKey = await keys.getRootKey(options.from);
  const newRootKey = await keys.getRootKey(options.to);

  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });

  const pending = await db
    .select()
    .from(orgKeys)
    .where(and(eq(orgKeys.rootKeyVersion, options.from), eq(orgKeys.status, 'active')));

  console.warn(
    `\nRoot key rotation ${options.from} → ${options.to}\n` +
      `  organisation keys to re-wrap: ${pending.length}\n` +
      (options.dryRun ? '  MODE: dry run, nothing will be written\n' : ''),
  );

  if (pending.length === 0) {
    console.warn('  Nothing to do.\n');
    return;
  }

  if (options.dryRun) {
    for (const row of pending) {
      console.warn(`  would re-wrap org ${row.orgId} (key version ${row.version})`);
    }
    console.warn('');
    return;
  }

  let rotated = 0;
  const failures: Array<{ orgId: string; reason: string }> = [];

  for (const row of pending) {
    const wrapped: WrappedOrgKey = {
      ciphertext: row.wrappedKey,
      iv: row.wrapIv,
      algorithm: 'AES-256-GCM',
      version: row.version,
      rootKeyVersion: row.rootKeyVersion,
    };

    try {
      const next = await rewrapOrgKey({
        oldRootKey,
        newRootKey,
        newRootKeyVersion: options.to,
        orgId: row.orgId,
        wrapped,
      });

      // One row per transaction. A partial rotation is safe — every row records
      // which root version wrapped it, so a re-run picks up exactly what is left.
      await db
        .update(orgKeys)
        .set({
          wrappedKey: next.ciphertext,
          wrapIv: next.iv,
          rootKeyVersion: next.rootKeyVersion,
        })
        .where(eq(orgKeys.id, row.id));

      rotated += 1;
    } catch (error) {
      // Never print the error object: a driver error can embed the connection
      // string, which contains the database password.
      failures.push({
        orgId: row.orgId,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  console.warn(`\n  re-wrapped: ${rotated}/${pending.length}`);

  if (failures.length > 0) {
    console.error('\n  FAILURES — these organisations are still on the old version:');
    for (const failure of failures) {
      console.error(`    ${failure.orgId}: ${failure.reason}`);
    }
    console.error(
      '\n  Do NOT remove the old key from XECRET_ROOT_KEYS. Re-run after\n' +
        '  investigating; already-rotated rows are skipped automatically.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.warn(
    '\n  ✅ All organisation keys re-wrapped.\n\n' +
      '  Next:\n' +
      '    1. Re-run with --dry-run to confirm zero rows remain.\n' +
      `    2. Set XECRET_ROOT_KEY_VERSION=${options.to} in Phase.dev and deploy.\n` +
      `    3. Remove version ${options.from} from XECRET_ROOT_KEYS.\n` +
      `    4. Retain version ${options.from} escrow shares for 90 days, then destroy.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
