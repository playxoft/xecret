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
 * Profile fields are taken from the provider verbatim, including when they are
 * absent — the provider is authoritative for them, so an avatar cleared upstream
 * clears here too.
 */
export async function upsertUserFromIdentity(
  exec: Executor,
  identity: VerifiedIdentity,
): Promise<User> {
  const now = new Date();
  const profile = {
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: identity.displayName ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  };

  const rows = await exec
    .insert(users)
    .values({
      id: uuidv7(),
      firebaseUid: identity.subject,
      ...profile,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.firebaseUid,
      set: { ...profile, updatedAt: now, lastLoginAt: now },
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
