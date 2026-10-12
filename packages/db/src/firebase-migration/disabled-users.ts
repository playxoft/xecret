import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
import { accountMembershipSummary, removeMember } from '../repositories/membership';
import type { AccountMembership } from '../repositories/membership';
import { RepositoryError } from '../repositories/shared';
import type { Executor } from '../repositories/shared';
import { sessions, users } from '../schema/identity';
import { cliTokens } from '../schema/tokens';
import type { BackfillDbRow } from './backfill';

/**
 * Firebase users an operator disabled, carried across the provider swap.
 *
 * The import skips them, because WorkOS has no disabled state and importing
 * one would switch it back on. Skipping alone is not enough: their xecret row
 * stays active and unlinked, and once the WorkOS sign-in is live the person
 * can sign up in AuthKit with the same verified address — and the linking
 * pass (§5 step 2) adopts that row. Firebase was the only thing keeping them
 * out, and Firebase is about to stop being asked.
 *
 * So before the deploy, each disabled user's row is either soft-deleted here
 * or knowingly kept (`--keep <uid>`). A soft delete is what makes "disabled"
 * survive the swap: both sign-in paths refuse a deleted row, by identity and
 * by address (`softDeleteUser`'s contract). Their sessions and CLI tokens are
 * revoked with it — Firebase's disable never touched xecret's own sessions, so
 * a disabled user could still hold a live one today.
 *
 * ── Memberships ──
 * A deleted user who stays a member is invisible on the members page but
 * still holds a seat and still counts as an active owner — so a co-owner
 * could leave an organisation owned only by someone who can never sign in.
 * So memberships are settled the way `deleteAccount` (web layer) settles
 * them ({@link planDisabledMemberships}):
 *
 *  - in an organisation with other members, the membership is **removed**
 *    (`removeMember`, which re-checks the last-owner rule under its own lock;
 *    grants go with the row);
 *  - if they are its **only active owner** among other members, nothing is
 *    written for that user at all: ownership must move first, or they are kept;
 *  - an organisation they are **alone in** is left exactly as it is — nobody
 *    else depends on it, and leaving it means a later restore gets it back.
 *    (`deleteAccount` soft-deletes those; this is a suspension, not erasure.)
 *
 * Otherwise *less* than account deletion: the vault is not touched. Clearing
 * `users.deleted_at` restores the account and its solo organisations; removed
 * memberships, revoked sessions and revoked tokens stay gone — they are
 * re-invited and sign in afresh.
 *
 * Not written to the audit log: audit records belong to an organisation and
 * this acts on an account, and the action vocabulary is being reshaped by the
 * WorkOS sign-in change. The script prints and files a record instead.
 */

export interface DisabledRowItem {
  readonly userId: string;
  readonly firebaseUid: string;
  /** `active`: will be soft-deleted unless kept. `already-deleted`: nothing to do. */
  readonly state: 'active' | 'already-deleted';
  /** Linked to a WorkOS user already — a sign-in got there first. */
  readonly linkedWorkosUserId: string | null;
  /** The operator chose to keep this one active (`--keep`). */
  readonly kept: boolean;
}

export interface DisabledPlan {
  readonly items: readonly DisabledRowItem[];
  /** Disabled Firebase users with no xecret row: they never signed in, so there is nothing to lock. */
  readonly withoutRow: readonly string[];
  /** `--keep` uids that are not a disabled user with a row: refused as a likely typo. */
  readonly unknownKeep: readonly string[];
}

export function planDisabledSoftDelete(input: {
  readonly rows: readonly BackfillDbRow[];
  readonly disabledUids: ReadonlySet<string>;
  readonly keep: ReadonlySet<string>;
}): DisabledPlan {
  const items: DisabledRowItem[] = [];
  const withRow = new Set<string>();
  for (const row of input.rows) {
    if (row.firebaseUid === null || !input.disabledUids.has(row.firebaseUid)) continue;
    withRow.add(row.firebaseUid);
    items.push({
      userId: row.id,
      firebaseUid: row.firebaseUid,
      state: row.deleted ? 'already-deleted' : 'active',
      linkedWorkosUserId: row.workosUserId,
      kept: input.keep.has(row.firebaseUid),
    });
  }
  return {
    items,
    withoutRow: [...input.disabledUids].filter((uid) => !withRow.has(uid)).sort(),
    unknownKeep: [...input.keep].filter((uid) => !withRow.has(uid)).sort(),
  };
}

export type MembershipAction =
  /** Others remain: the membership is removed. */
  | 'remove'
  /** Their only active owner among others: blocks the soft delete. */
  | 'blocks'
  /** Alone in it: left as it is. */
  | 'solo';

export interface PlannedMembership {
  readonly membership: AccountMembership;
  readonly action: MembershipAction;
}

/** `planAccountDeletion`'s rules (apps/web account-service), except that solo organisations stay. */
export function planDisabledMemberships(
  memberships: readonly AccountMembership[],
): PlannedMembership[] {
  return memberships.map((membership) => {
    if (membership.totalMembers <= 1) return { membership, action: 'solo' };
    // Only an *active* owner is the owner an organisation depends on.
    const isActiveOwner = membership.role === 'owner' && membership.status === 'active';
    if (isActiveOwner && membership.activeOwners <= 1) return { membership, action: 'blocks' };
    return { membership, action: 'remove' };
  });
}

/** A user's memberships and what a soft delete would do with each. Read-only. */
export async function planMembershipsFor(
  exec: Executor,
  userId: string,
): Promise<PlannedMembership[]> {
  return planDisabledMemberships(await accountMembershipSummary(exec, userId));
}

export type SoftDeleteResult =
  | {
      readonly result: 'soft-deleted';
      readonly revokedSessions: number;
      readonly revokedCliTokens: number;
      readonly removedFromOrgs: readonly string[];
      readonly soloOrgs: readonly string[];
    }
  /** Their only active owner among others in these organisations. Nothing written. */
  | { readonly result: 'blocked'; readonly orgIds: readonly string[] }
  /** Already deleted, or the row no longer carries this Firebase uid. Nothing written. */
  | { readonly result: 'not-active' };

class Blocked extends Error {
  constructor(readonly orgIds: readonly string[]) {
    super('blocked');
  }
}

/**
 * Soft-deletes one disabled user's row, settles their memberships and revokes
 * what they can still use, all in one transaction — or writes nothing.
 *
 * The row is locked and re-read first (still this Firebase user's, still
 * active), and the memberships are planned from inside the transaction, so a
 * plan made from an earlier read cannot act on a changed state. A last-owner
 * refusal from `removeMember` (a co-owner left meanwhile) rolls everything
 * back and is reported as `blocked`.
 */
export async function softDeleteDisabledRow(
  db: Database,
  userId: string,
  firebaseUid: string,
): Promise<SoftDeleteResult> {
  try {
    return await db.transaction((tx) => softDeleteInTransaction(tx, userId, firebaseUid));
  } catch (error) {
    if (error instanceof Blocked) return { result: 'blocked', orgIds: error.orgIds };
    if (error instanceof RepositoryError && error.code === 'lastOwner') {
      return { result: 'blocked', orgIds: [] };
    }
    throw error;
  }
}

async function softDeleteInTransaction(
  tx: Executor,
  userId: string,
  firebaseUid: string,
): Promise<SoftDeleteResult> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.firebaseUid, firebaseUid), isNull(users.deletedAt)))
    .for('update');
  if (row === undefined) return { result: 'not-active' } as const;

  const planned = await planMembershipsFor(tx, userId);
  const blocking = planned.filter((p) => p.action === 'blocks').map((p) => p.membership.orgId);
  // Thrown rather than returned, so this can never commit a partial write,
  // whatever comes to sit above it.
  if (blocking.length > 0) throw new Blocked(blocking);
  const removedFromOrgs: string[] = [];
  for (const { membership, action } of planned) {
    if (action !== 'remove') continue;
    await removeMember(tx, { orgId: membership.orgId, memberId: membership.memberId }, null);
    removedFromOrgs.push(membership.orgId);
  }

  const now = new Date();
  await tx
    .update(users)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  const revokedSessions = await tx
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  const revokedCliTokens = await tx
    .update(cliTokens)
    .set({ revokedAt: now })
    .where(and(eq(cliTokens.userId, userId), isNull(cliTokens.revokedAt)))
    .returning({ id: cliTokens.id });
  return {
    result: 'soft-deleted',
    revokedSessions: revokedSessions.length,
    revokedCliTokens: revokedCliTokens.length,
    removedFromOrgs,
    soloOrgs: planned.filter((p) => p.action === 'solo').map((p) => p.membership.orgId),
  } as const;
}
