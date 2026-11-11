#!/usr/bin/env -S npx tsx
/**
 * xecret's admins — who may open the admin page (`/app/admin`) — by hand.
 *
 *   phase run --env Production -- npm run admin -- --list
 *   phase run --env Production -- npm run admin -- --add someone@example.com
 *   phase run --env Production -- npm run admin -- --remove someone@example.com
 *
 * ## Why a script, when the page does this too
 *
 * The page adds and removes admins — but only an admin can open it, so the
 * first one has to come from somewhere else. This is that somewhere: a person
 * holding database credentials. It is also the way back in if every admin
 * account is lost. The rules are the page's own (`platform-admins.ts`): the
 * account must exist, be live and be verified, and the last admin is never
 * removed — not even from here.
 *
 * ## What it records
 *
 * A `platform_admin_changes` row per change, attributed to the operator named
 * by `--operator` or by `$USER` — a label, not an account, as `plan:set`'s
 * audit rows are. It sends no email (it has no mailer); the page does, and the
 * Admins tab shows the change.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { createDatabaseHandle } from '../packages/db/src/client.ts';
import {
  addPlatformAdmin,
  listPlatformAdmins,
  removePlatformAdmin,
} from '../packages/db/src/repositories/platform-admins.ts';
import { users } from '../packages/db/src/schema/identity.ts';

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`);
  return value;
}

/** ASCII only, as the page compares: a look-alike address never names somebody else. */
function asciiAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[!-~]+@[!-~]+\.[!-~]+$/.test(trimmed)) return null;
  return trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) fail('DATABASE_URL is not set. Try: phase run -- npm run admin -- --list');

  const add = argument('add');
  const remove = argument('remove');
  const list = process.argv.includes('--list');
  if ([add, remove].filter((value) => value !== null).length + (list ? 1 : 0) !== 1) {
    fail('Pass exactly one of --list, --add <address> or --remove <address>.');
  }
  const operator =
    argument('operator') ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown-operator';

  const { db, end } = createDatabaseHandle({ connectionString: url });
  try {
    if (list) {
      const admins = await listPlatformAdmins(db);
      if (admins.length === 0) console.log('  No admins yet. Add the first with --add <address>.');
      for (const admin of admins) {
        console.log(
          `  ${admin.email}  added ${admin.addedAt.toISOString()}` +
            (admin.addedByEmail ? ` by ${admin.addedByEmail}` : ' by an operator'),
        );
      }
      return;
    }

    const address = asciiAddress((add ?? remove)!);
    if (address === null) fail('That is not an address in plain ASCII.');
    const [user] = await db
      .select({ id: users.id, email: users.email, verified: users.emailVerified })
      .from(users)
      .where(and(eq(users.email, address), isNull(users.deletedAt)))
      .limit(1);
    if (!user || asciiAddress(user.email) !== address) {
      fail(`No live account uses ${address}. They sign in to xecret once, and then can be added.`);
    }

    const by = { label: `operator: ${operator}` };
    if (add !== null) {
      if (!user.verified) fail(`${address} has not verified its address yet.`);
      const outcome = await db.transaction((tx) =>
        addPlatformAdmin(tx, { userId: user.id, email: user.email, by }),
      );
      console.log(outcome === 'added' ? `✓ ${address} is an admin.` : `  ${address} already was.`);
    } else {
      const outcome = await db.transaction((tx) =>
        removePlatformAdmin(tx, { userId: user.id, email: user.email, by }),
      );
      if (outcome === 'last') fail(`${address} is the last admin, and the last one stays.`);
      console.log(
        outcome === 'removed' ? `✓ ${address} is no longer an admin.` : `  ${address} was not one.`,
      );
    }
  } finally {
    await end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
