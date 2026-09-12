import { and, eq, isNull } from 'drizzle-orm';
import type { VerifiedIdentity } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Users. See docs/adr/0003-firebase-as-identity-provider.md.
 *
 * Firebase attests to an identity; this table is xecret's own record of it, and
 * `firebase_uid` is the only coupling to the provider.
 *
 * Every read here excludes soft-deleted rows. That is not tidiness: a deleted
 * account must stop resolving everywhere at the same instant, and
 * `users_firebase_uid_idx` is partial on `deleted_at IS NULL`, so the predicate
 * that enforces it is also the one that keeps the lookup indexed.
 */

export type User = typeof users.$inferSelect;

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const EMAIL_UNIQUE_CONSTRAINT = 'users_email_unique';

/**
 * True when `error`, or anything it wraps, is a violation of `constraint`.
 *
 * Drizzle wraps driver failures in `DrizzleQueryError`, so the SQLSTATE lives on
 * `cause` rather than on the error itself — hence the walk. Matching the
 * constraint name rather than merely SQLSTATE 23505 keeps the mapping precise:
 * a table with two unique indexes has two failures that mean different things to
 * the caller, and collapsing them would produce a misleading message.
 *
 * Exported because other repositories map their own constraint violations onto
 * `RepositoryError` the same way.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === UNIQUE_VIOLATION &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

export async function findUserByFirebaseUid(
  exec: Executor,
  firebaseUid: string,
): Promise<User | null> {
  const [row] = await exec
    .select()
    .from(users)
    .where(and(eq(users.firebaseUid, firebaseUid), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * Looks up a user by primary key.
 *
 * Needed by the CLI-token path: a CLI token stores `user_id` but not the profile
 * behind it, and `xecret whoami` has to be able to say whose token it is. Kept
 * off the authentication hot path — the token row alone is enough to authorise a
 * request, so this is only paid when the profile is actually asked for.
 */
export async function findUserById(exec: Executor, userId: string): Promise<User | null> {
  const [row] = await exec
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * Looks up a user by email address.
 *
 * `email` is `citext`, so the comparison is already case-insensitive in the
 * database. Lowercasing the argument here would be redundant and, worse,
 * misleading — it would suggest the column is case-sensitive and that every
 * other call site must remember to do the same.
 */
export async function findUserByEmail(exec: Executor, email: string): Promise<User | null> {
  const [row] = await exec
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * Creates the user on first login, or refreshes the mirrored profile on every
 * login after that.
 *
 * The write is an upsert on `firebase_uid` rather than a read-then-insert
 * because two concurrent first logins are a real possibility, not a theoretical
 * one: a cold start plus a double-clicked sign-in button issues two requests
 * that both find no row. The unique index is the only thing that actually
 * prevents a duplicate account; `ON CONFLICT` is how the loser of that race
 * turns into a successful login instead of a 500.
 *
 * Most profile fields are taken from the provider verbatim, including when they
 * are absent — the provider is authoritative for them, so an avatar cleared
 * upstream clears here too.
 *
 * ── Except the display name, which the account owns ──
 * It seeds from the provider on the row's *first* write and is never overwritten
 * afterwards. That is the whole of what makes {@link updateUserProfile} mean
 * anything: a name edited in xecret and then re-mirrored from Google on the next
 * sign-in is not an editable field, it is a field that silently reverts — and
 * the revert would land at a sign-in, hours later, where nobody would connect it
 * to the edit. Nothing is lost in the other direction either: an account that
 * has never renamed itself here still has exactly the provider's name, because
 * that is what was inserted.
 */
export async function upsertUserFromIdentity(
  exec: Executor,
  identity: VerifiedIdentity,
): Promise<User> {
  const now = new Date();
  const mirrored = {
    email: identity.email,
    emailVerified: identity.emailVerified,
    avatarUrl: identity.avatarUrl ?? null,
  };

  const rows = await exec
    .insert(users)
    .values({
      id: uuidv7(),
      firebaseUid: identity.subject,
      ...mirrored,
      displayName: identity.displayName ?? null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.firebaseUid,
      set: { ...mirrored, updatedAt: now, lastLoginAt: now },
      // A soft-deleted account is not revived by signing in again. The Firebase
      // account may well still exist after the xecret account was deleted, and
      // silently restoring the row would restore its memberships and grants with
      // it — which is exactly what deleting the account was meant to end.
      setWhere: isNull(users.deletedAt),
    })
    .returning()
    .catch(rethrowEmailCollision);

  const row = rows[0];
  if (!row) {
    // `setWhere` suppressed the update, so the conflicting row is soft-deleted.
    throw new RepositoryError('notFound', 'No active account exists for this identity.');
  }

  return row;
}

/** What an account may change about its own profile. */
export interface UserProfilePatch {
  /** `null` clears it, which puts the account back to being named by its email. */
  displayName?: string | null | undefined;
}

/**
 * Changes the profile fields an account owns rather than mirrors.
 *
 * `updated_at` moves, unlike {@link touchLastLogin}: this *is* a change to the
 * record, and it is the one the column exists to date.
 *
 * A patch with nothing in it re-reads and returns the row rather than issuing an
 * empty `SET`, which Postgres rejects — the same shape `updateOrganization`
 * keeps, so a caller that validated "at least one field" upstream and a caller
 * that did not both behave.
 */
export async function updateUserProfile(
  exec: Executor,
  userId: string,
  patch: UserProfilePatch,
): Promise<User> {
  if (patch.displayName === undefined) {
    const current = await findUserById(exec, userId);
    if (!current) throw new RepositoryError('notFound', 'No active account.');
    return current;
  }

  const [row] = await exec
    .update(users)
    .set({ displayName: patch.displayName, updatedAt: new Date() })
    // The soft-delete predicate every read here carries. A deleted account must
    // not be renameable by a session that was issued before it went.
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning();

  if (!row) throw new RepositoryError('notFound', 'No active account.');
  return row;
}

/**
 * Soft-deletes an account.
 *
 * The row survives because the audit log and `secret_versions.created_by`
 * reference it — "who wrote this secret" must keep an answer after the author
 * is gone. What ends is the *account*: `upsertUserFromIdentity` refuses to
 * revive a soft-deleted row (`setWhere`), so the same Firebase identity can
 * never sign in to it again. The caller is responsible for what surrounds the
 * row — sessions, tokens, memberships — which is `deleteAccount` in the web
 * layer, inside one transaction with this.
 */
export async function softDeleteUser(exec: Executor, userId: string): Promise<void> {
  const now = new Date();
  await exec
    .update(users)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}

/**
 * Records that the user authenticated.
 *
 * Deliberately does not touch `updated_at`: that column tracks changes to the
 * profile, and moving it on every login would make "when did this record last
 * change" unanswerable.
 */
export async function touchLastLogin(exec: Executor, userId: string): Promise<void> {
  await exec
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}

/**
 * A Firebase account whose email address changes can collide with an existing
 * xecret user — two people, one of whom typed the other's address into an
 * account they control. That must surface as a conflict the caller can explain,
 * not as a driver error that becomes a 500.
 */
function rethrowEmailCollision(error: unknown): never {
  if (isUniqueViolation(error, EMAIL_UNIQUE_CONSTRAINT)) {
    throw new RepositoryError('conflict', 'That email address belongs to another account.');
  }
  throw error;
}
