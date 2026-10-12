import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client';
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
 * Deliberately *less* than account deletion (`deleteAccount` in the web
 * layer): no vault, organisation or membership is touched. This is the analogue
 * of Firebase's switch, not of erasure, and it is undone by clearing
 * `users.deleted_at` (the person then signs in afresh; revoked sessions stay
 * revoked).
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

export type SoftDeleteResult =
  | {
      readonly result: 'soft-deleted';
      readonly revokedSessions: number;
      readonly revokedCliTokens: number;
    }
  /** Already deleted, or the row no longer carries this Firebase uid. Nothing written. */
  | { readonly result: 'not-active' };

/**
 * Soft-deletes one disabled user's row and revokes what it can still use, in
 * one transaction. The UPDATE re-asserts the row is still this Firebase user's
 * and still active, so a plan made from a stale read cannot hit another row.
 */
export async function softDeleteDisabledRow(
  db: Database,
  userId: string,
  firebaseUid: string,
): Promise<SoftDeleteResult> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const deleted = await tx
      .update(users)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), eq(users.firebaseUid, firebaseUid), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (deleted.length === 0) return { result: 'not-active' } as const;
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
    } as const;
  });
}
