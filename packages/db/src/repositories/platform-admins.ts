import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { users } from '../schema/identity';
import { platformAdminChanges, platformAdmins } from '../schema/platform';
import type { Executor, Transaction } from './shared';

/**
 * Who xecret's admins are (migration 0035), and the record of every change.
 *
 * ── The one rule ──
 * There is always at least one. Removing the last admin is refused here, under
 * a lock every add and remove takes, so two admins removing each other at the
 * same moment cannot leave nobody: the second finds one row where it expected
 * two, and is refused.
 *
 * Who may call the writers is the caller's question (`server/admin.ts`, or an
 * operator at a shell with `npm run admin`).
 */

/**
 * The transaction-scoped lock every change to the admin list takes. An
 * advisory lock rather than a row lock: the rule is about the whole table,
 * and the role holds no UPDATE it could take `FOR UPDATE` with.
 */
async function lockAdminList(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('xecret.platform_admins'))`);
}

/** Whether this account is an admin — a live account, and a row for it. */
export async function isPlatformAdmin(exec: Executor, userId: string): Promise<boolean> {
  const [row] = await exec
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .innerJoin(users, and(eq(users.id, platformAdmins.userId), isNull(users.deletedAt)))
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  return row !== undefined;
}

/** An admin, as the admin page lists them. */
export interface PlatformAdminListing {
  userId: string;
  email: string;
  displayName: string | null;
  addedAt: Date;
  /** The address of the admin who added this one; `null` for an operator, or one since deleted. */
  addedByEmail: string | null;
}

/** Every live admin, longest-serving first. */
export async function listPlatformAdmins(exec: Executor): Promise<PlatformAdminListing[]> {
  const adder = alias(users, 'adder');
  return exec
    .select({
      userId: platformAdmins.userId,
      email: users.email,
      displayName: users.displayName,
      addedAt: platformAdmins.addedAt,
      addedByEmail: adder.email,
    })
    .from(platformAdmins)
    .innerJoin(users, and(eq(users.id, platformAdmins.userId), isNull(users.deletedAt)))
    .leftJoin(adder, eq(adder.id, platformAdmins.addedBy))
    .orderBy(asc(platformAdmins.addedAt), asc(platformAdmins.userId))
    .limit(200);
}

/** Who made a change: an admin's account, or an operator's label at a shell. */
export type AdminChangeActor = { userId: string } | { label: string };

function actorColumns(by: AdminChangeActor): { byUserId: string | null; byLabel: string | null } {
  return 'userId' in by
    ? { byUserId: by.userId, byLabel: null }
    : { byUserId: null, byLabel: by.label.slice(0, 128) };
}

/** Makes an account an admin, and records it. `already` when it was one. */
export async function addPlatformAdmin(
  tx: Transaction,
  params: { userId: string; email: string; by: AdminChangeActor },
): Promise<'added' | 'already'> {
  await lockAdminList(tx);
  const inserted = await tx
    .insert(platformAdmins)
    .values({
      userId: params.userId,
      addedBy: 'userId' in params.by ? params.by.userId : null,
    })
    .onConflictDoNothing()
    .returning({ userId: platformAdmins.userId });
  if (inserted.length === 0) return 'already';

  await tx.insert(platformAdminChanges).values({
    action: 'added',
    userId: params.userId,
    email: params.email,
    ...actorColumns(params.by),
  });
  return 'added';
}

/**
 * Removes an admin, and records it — never the last one (`last`). `not-admin`
 * when the account was not one.
 */
export async function removePlatformAdmin(
  tx: Transaction,
  params: { userId: string; email: string; by: AdminChangeActor },
): Promise<'removed' | 'not-admin' | 'last'> {
  await lockAdminList(tx);
  const [existing] = await tx
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, params.userId))
    .limit(1);
  if (existing === undefined) return 'not-admin';

  // Live admins only: a row whose account was soft-deleted cannot sign in,
  // so it does not count towards "there is still somebody".
  const [remaining] = await tx
    .select({ value: count() })
    .from(platformAdmins)
    .innerJoin(users, and(eq(users.id, platformAdmins.userId), isNull(users.deletedAt)));
  if ((remaining?.value ?? 0) <= 1) return 'last';

  await tx.delete(platformAdmins).where(eq(platformAdmins.userId, params.userId));
  await tx.insert(platformAdminChanges).values({
    action: 'removed',
    userId: params.userId,
    email: params.email,
    ...actorColumns(params.by),
  });
  return 'removed';
}
