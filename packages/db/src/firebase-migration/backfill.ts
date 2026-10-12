import { and, eq, isNull } from 'drizzle-orm';
import { users } from '../schema/identity';
import { isConstraintViolation } from '../repositories/shared';
import type { Executor } from '../repositories/shared';
import { sameAddress } from './import-plan';
import type { SkipReason } from './import-plan';
import type { MappingEntry } from './mapping';
import type { WorkosUserSummary } from './workos-api';

/**
 * The second pass of the user import: write each imported WorkOS id onto the
 * row that holds the same Firebase uid.
 *
 *   UPDATE users SET workos_user_id = $w
 *    WHERE firebase_uid = $f AND workos_user_id IS NULL
 *
 * It is the one writer of `workos_user_id` besides the linking pass (migration
 * 0018's header), and it is held to that header's rules:
 *
 *  - **It only fills a NULL.** A row a WorkOS sign-in already linked is never
 *    touched, whatever the mapping says; a difference is reported.
 *  - **It reports, never forces, the two refusals** the schema can raise:
 *    `23505` on `users_workos_user_id_unique` (that WorkOS id is already on a
 *    *different* row) and `23514` on `users_workos_user_id_format_check` (not a
 *    WorkOS id at all). A human resolves those.
 *  - **It never links a Firebase user the current export does not import**
 *    (disabled, unverified, …), whatever an older mapping says, and it reports
 *    loudly a row of such a user that a WorkOS sign-in has linked meanwhile —
 *    for a disabled user that means the person has access again.
 *  - **Soft-deleted rows are linked like any other.** Linking one does not
 *    reopen the account: the linking pass refuses a deleted holder whether it
 *    reaches it by identity or by address. What it does change is that a row
 *    restored later comes back already linked, and that the decommission
 *    migration has one fewer unlinked row to decide about (0018's warning on
 *    `users_identity_present_check`).
 *
 * Each row is its own statement, outside any transaction, so one refusal
 * neither aborts nor rolls back the rest. Nothing here writes the audit log:
 * the script's output and the mapping file are the record of a backfill.
 */

export interface BackfillDbRow {
  readonly id: string;
  readonly firebaseUid: string | null;
  readonly workosUserId: string | null;
  readonly email: string;
  readonly deleted: boolean;
}

export type MappingRejection =
  /** The id does not exist in the WorkOS environment whose key is in use. */
  | 'workos-user-missing'
  /** It exists, but is not the person the mapping says it is. */
  | 'workos-identity-mismatch'
  /** It exists and matches, but WorkOS has not verified the address. */
  | 'workos-user-unverified';

/**
 * Re-checks one mapping entry against the live WorkOS user before it is
 * allowed to become a link.
 *
 * The mapping file is trusted to say *which* id; WorkOS is asked whether that
 * id still is who the mapping says. That catches a mapping from the other
 * environment (the id is missing here), a user deleted and re-created since
 * the import, and a hand-edited file. A link is the strongest claim this
 * database makes about a person — the linking pass's step 1 honours it with no
 * further question — so it is written only for a verified user that is
 * provably the imported one: `external_id` is this uid, or, for a user the
 * import reused rather than created, the address is the Firebase address.
 */
export function checkMappedUser(
  firebaseUid: string,
  entry: MappingEntry,
  firebaseEmail: string | null,
  workosUser: WorkosUserSummary | null,
): MappingRejection | null {
  if (workosUser === null || workosUser.id !== entry.workosUserId) return 'workos-user-missing';
  const provenByExternalId = workosUser.externalId === firebaseUid;
  const provenByAddress =
    entry.outcome === 'reuse-existing' &&
    workosUser.externalId === null &&
    firebaseEmail !== null &&
    sameAddress(workosUser.email, firebaseEmail);
  if (!provenByExternalId && !provenByAddress) return 'workos-identity-mismatch';
  if (!workosUser.emailVerified) return 'workos-user-unverified';
  return null;
}

export type BackfillPlanItem =
  | {
      readonly action: 'update';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly workosUserId: string;
      readonly deleted: boolean;
    }
  | {
      readonly action: 'already-linked';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly workosUserId: string;
    }
  /** Linked to a different WorkOS id already. Never overwritten. */
  | {
      readonly action: 'linked-elsewhere';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly currentWorkosUserId: string;
      readonly mappedWorkosUserId: string;
    }
  /** Another row already holds the mapped WorkOS id: the UPDATE would be a 23505. */
  | {
      readonly action: 'held-by-other-row';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly workosUserId: string;
      readonly holderUserId: string;
    }
  | {
      readonly action: 'mapping-rejected';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly reason: MappingRejection;
    }
  /** The current export does not import this Firebase user. Any mapping entry is ignored. */
  | {
      readonly action: 'not-importable';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly reason: SkipReason;
      readonly deleted: boolean;
      /** An older mapping had an entry for this uid; it was not used. */
      readonly mappingIgnored: boolean;
    }
  /**
   * The current export does not import this Firebase user, but a WorkOS
   * sign-in has linked the row anyway. For a *disabled* user that means the
   * person has access again — reported loudly.
   */
  | {
      readonly action: 'linked-but-not-importable';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly reason: SkipReason;
      readonly currentWorkosUserId: string;
      readonly deleted: boolean;
    }
  /** Importable, but not in the mapping: not imported yet, or the import reported it. */
  | {
      readonly action: 'not-imported';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly deleted: boolean;
    }
  /** Not in the mapping, but a WorkOS sign-in linked the row already. Nothing to write. */
  | {
      readonly action: 'linked-not-imported';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly currentWorkosUserId: string;
    }
  /** The row's Firebase uid is not in the export at all. */
  | {
      readonly action: 'no-firebase-user';
      readonly userId: string;
      readonly firebaseUid: string;
      readonly deleted: boolean;
    };

/**
 * A row this backfill links (or found linked) to a WorkOS user whose current
 * address another row holds. The link is right — it is the same Firebase
 * account — but that person's first WorkOS sign-in will try to bring the row's
 * address in line with WorkOS's (§5 rule 5), collide with the other row, and
 * be answered 409 until a human sorts the two rows out.
 */
export interface EmailHolderWarning {
  readonly userId: string;
  readonly firebaseUid: string;
  readonly workosUserId: string;
  readonly holderUserId: string;
}

export interface BackfillPlan {
  readonly items: readonly BackfillPlanItem[];
  readonly emailHolders: readonly EmailHolderWarning[];
  /** Firebase users in the export with no row: they never signed in to xecret. */
  readonly firebaseUidsWithoutRow: readonly string[];
  /** Rows with no Firebase uid (WorkOS-era accounts). Nothing to backfill. */
  readonly rowsWithoutFirebaseUid: number;
}

export function planBackfill(input: {
  readonly rows: readonly BackfillDbRow[];
  readonly exportUids: ReadonlySet<string>;
  /** uid → WorkOS id, for entries that passed {@link checkMappedUser}. */
  readonly mapping: ReadonlyMap<string, string>;
  readonly rejected: ReadonlyMap<string, MappingRejection>;
  /** Why the current export does not import a uid (see `classifyFirebaseUser`). */
  readonly skipReasons: ReadonlyMap<string, SkipReason>;
  /** uid → the mapped WorkOS user's current address, for accepted entries. */
  readonly mappedEmails: ReadonlyMap<string, string>;
}): BackfillPlan {
  const holders = new Map<string, string>();
  const rowUids = new Set<string>();
  // Folded the way citext compares (lower()), Unicode included: over-matching
  // only adds a warning, under-matching would miss a 409.
  const emailOwners = new Map<string, string>();
  let rowsWithoutFirebaseUid = 0;
  for (const row of input.rows) {
    if (row.workosUserId !== null) holders.set(row.workosUserId, row.id);
    if (row.firebaseUid !== null) rowUids.add(row.firebaseUid);
    else rowsWithoutFirebaseUid += 1;
    emailOwners.set(row.email.toLowerCase(), row.id);
  }
  const emailHolders: EmailHolderWarning[] = [];
  const checkEmailHolder = (userId: string, firebaseUid: string, workosUserId: string) => {
    const email = input.mappedEmails.get(firebaseUid);
    const holderUserId = email === undefined ? undefined : emailOwners.get(email.toLowerCase());
    if (holderUserId !== undefined && holderUserId !== userId) {
      emailHolders.push({ userId, firebaseUid, workosUserId, holderUserId });
    }
  };

  const items: BackfillPlanItem[] = [];
  for (const row of input.rows) {
    const { id: userId, firebaseUid, deleted } = row;
    if (firebaseUid === null) continue;
    if (!input.exportUids.has(firebaseUid)) {
      items.push({ action: 'no-firebase-user', userId, firebaseUid, deleted });
      continue;
    }
    const skipReason = input.skipReasons.get(firebaseUid);
    if (skipReason !== undefined) {
      items.push(
        row.workosUserId !== null
          ? {
              action: 'linked-but-not-importable',
              userId,
              firebaseUid,
              reason: skipReason,
              currentWorkosUserId: row.workosUserId,
              deleted,
            }
          : {
              action: 'not-importable',
              userId,
              firebaseUid,
              reason: skipReason,
              deleted,
              mappingIgnored: input.mapping.has(firebaseUid) || input.rejected.has(firebaseUid),
            },
      );
      continue;
    }
    const rejection = input.rejected.get(firebaseUid);
    if (rejection !== undefined) {
      items.push({ action: 'mapping-rejected', userId, firebaseUid, reason: rejection });
      continue;
    }
    const workosUserId = input.mapping.get(firebaseUid);
    if (workosUserId === undefined) {
      items.push(
        row.workosUserId !== null
          ? {
              action: 'linked-not-imported',
              userId,
              firebaseUid,
              currentWorkosUserId: row.workosUserId,
            }
          : { action: 'not-imported', userId, firebaseUid, deleted },
      );
      continue;
    }
    if (row.workosUserId === workosUserId) {
      items.push({ action: 'already-linked', userId, firebaseUid, workosUserId });
      checkEmailHolder(userId, firebaseUid, workosUserId);
      continue;
    }
    if (row.workosUserId !== null) {
      items.push({
        action: 'linked-elsewhere',
        userId,
        firebaseUid,
        currentWorkosUserId: row.workosUserId,
        mappedWorkosUserId: workosUserId,
      });
      continue;
    }
    const holderUserId = holders.get(workosUserId);
    if (holderUserId !== undefined) {
      items.push({ action: 'held-by-other-row', userId, firebaseUid, workosUserId, holderUserId });
      continue;
    }
    items.push({ action: 'update', userId, firebaseUid, workosUserId, deleted });
    checkEmailHolder(userId, firebaseUid, workosUserId);
  }

  return {
    items,
    emailHolders,
    firebaseUidsWithoutRow: [...input.exportUids].filter((uid) => !rowUids.has(uid)).sort(),
    rowsWithoutFirebaseUid,
  };
}

export async function loadBackfillRows(exec: Executor): Promise<BackfillDbRow[]> {
  const rows = await exec
    .select({
      id: users.id,
      firebaseUid: users.firebaseUid,
      workosUserId: users.workosUserId,
      email: users.email,
      deletedAt: users.deletedAt,
    })
    .from(users);
  return rows.map(({ deletedAt, ...row }) => ({ ...row, deleted: deletedAt !== null }));
}

export type BackfillWriteResult =
  | { readonly result: 'updated' }
  /** Nothing to do: the row already holds this id (a sign-in or an earlier run linked it). */
  | { readonly result: 'already-linked' }
  /** The row holds a different id. Not overwritten. */
  | { readonly result: 'linked-elsewhere'; readonly currentWorkosUserId: string | null }
  | { readonly result: 'row-missing' }
  /** 23505: another row already holds this WorkOS id. */
  | { readonly result: 'unique-violation'; readonly holderUserId: string | null }
  /** 23514: not a WorkOS user id. */
  | { readonly result: 'format-violation' };

/**
 * The backfill's one write. Never call it inside a transaction: a refusal
 * aborts the transaction it happens in.
 */
export async function writeBackfillLink(
  exec: Executor,
  firebaseUid: string,
  workosUserId: string,
): Promise<BackfillWriteResult> {
  try {
    const updated = await exec
      .update(users)
      .set({ workosUserId })
      .where(and(eq(users.firebaseUid, firebaseUid), isNull(users.workosUserId)))
      .returning({ id: users.id });
    if (updated.length > 0) return { result: 'updated' };
  } catch (error) {
    if (isConstraintViolation(error, '23505', 'users_workos_user_id_unique')) {
      const [holder] = await exec
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
        .limit(1);
      return { result: 'unique-violation', holderUserId: holder?.id ?? null };
    }
    if (isConstraintViolation(error, '23514', 'users_workos_user_id_format_check')) {
      return { result: 'format-violation' };
    }
    throw error;
  }

  // Nothing matched: say why, from the row as it is now.
  const [row] = await exec
    .select({ workosUserId: users.workosUserId })
    .from(users)
    .where(eq(users.firebaseUid, firebaseUid))
    .limit(1);
  if (row === undefined) return { result: 'row-missing' };
  if (row.workosUserId === workosUserId) return { result: 'already-linked' };
  return { result: 'linked-elsewhere', currentWorkosUserId: row.workosUserId };
}
