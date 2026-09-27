import { and, eq, isNull } from 'drizzle-orm';
import type { VerifiedIdentity, WorkosIdentity } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { users } from '../schema/identity';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Users. See docs/adr/0003-firebase-as-identity-provider.md, and
 * `.local/workos-auth.md` for the provider migration in progress.
 *
 * A provider attests to an identity; this table is xecret's own record of it.
 * For the length of the migration there are two couplings, one per provider,
 * and each has exactly one writer that touches only its own column:
 *
 *  - `firebase_uid`, keyed on by the live Firebase sign-in
 *    ({@link upsertUserFromFirebaseIdentity}). It goes when that path does.
 *  - `workos_user_id`, keyed on by the WorkOS callback's linking pass
 *    ({@link upsertUserFromWorkosIdentity}), which is also the only code that
 *    ever adopts an existing account by email.
 *
 * Every lookup exported here excludes soft-deleted rows. That is not tidiness: a
 * deleted account must stop resolving everywhere at the same instant, and
 * `users_firebase_uid_idx` is partial on `deleted_at IS NULL`, so the predicate
 * that enforces it is also the one that keeps the lookup indexed. The linking
 * pass is the one deliberate exception — it reads deleted rows so that it can
 * *refuse* them as deleted, rather than mistake an absent row for a new user.
 */

export type User = typeof users.$inferSelect;

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const EMAIL_UNIQUE_CONSTRAINT = 'users_email_unique';

const WORKOS_USER_ID_UNIQUE_CONSTRAINT = 'users_workos_user_id_unique';

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
      // postgres.js names the field `constraint_name`; PGlite, which the
      // repository tests run against, follows node-postgres and calls it
      // `constraint`. Accepting both is what lets those tests exercise this
      // mapping for real instead of around it.
      (('constraint_name' in current && current.constraint_name === constraint) ||
        ('constraint' in current && current.constraint === constraint))
    ) {
      return true;
    }
  }
  return false;
}

export async function findUserByWorkosId(
  exec: Executor,
  workosUserId: string,
): Promise<User | null> {
  const [row] = await exec
    .select()
    .from(users)
    .where(and(eq(users.workosUserId, workosUserId), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
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
 * The Firebase sign-in's upsert: creates the user on first login, or refreshes
 * the mirrored profile on every login after that.
 *
 * Its one caller is `POST /api/auth/session`, and it is deleted together with
 * that route in WS-2 of the WorkOS migration. Until then it is byte-for-byte
 * the behaviour that shipped before the WorkOS columns existed.
 *
 * ── It is not the WorkOS linking pass, and must never become it ──
 * It keys on `firebase_uid`, writes `firebase_uid`, and neither reads nor
 * writes `workos_user_id`. It never matches by email: a Firebase uid it has not
 * seen is a new account, and an address another row already holds is a
 * conflict (`users_email_unique`), exactly as it always was. Passing a Firebase
 * identity to {@link upsertUserFromWorkosIdentity} instead writes a Firebase uid
 * into the WorkOS column, splits a changed address into a second account, and
 * signs a *different* Firebase account into an existing one by email — which is
 * why that function's parameter refuses anything not branded by WorkOS, and
 * why this one's refuses anything that is.
 *
 * ── Why an upsert ──
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
export async function upsertUserFromFirebaseIdentity(
  exec: Executor,
  identity: VerifiedIdentity & { readonly provider?: never },
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

export type IdentityLinkOutcome =
  /**
   * The provider id was already on a row. The ordinary login — including the
   * loser of a race with a concurrent sign-in of the same identity, which finds
   * the row the winner just wrote.
   */
  | 'matched'
  /** A pre-existing account was claimed by verified email. Audited loudly. */
  | 'linked'
  /** Nobody held this identity or this address. A new account. */
  | 'created';

export interface UpsertedUser {
  user: User;
  outcome: IdentityLinkOutcome;
}

/**
 * The WorkOS linking pass: resolves a WorkOS-attested identity to a user row,
 * adopting or creating one as needed.
 *
 * Implements the normative order in `.local/workos-auth.md` §5: provider id,
 * then **verified** email, then create. Each step is documented at the branch
 * that performs it; the rule that governs all of them is that an unverified
 * address is refused before any of them runs.
 *
 * ── Outcomes, and the refusals ──
 *  - `forbidden` — the provider has not verified the address. No query runs.
 *  - `notFound` — the account this identity or this address belongs to was
 *    soft-deleted. Terminal: the caller says "deleted", never "try again".
 *  - `conflict` — the address, or the identity, is already bound to a
 *    *different* account. Never resolved by relinking.
 *
 * ── Why a sequence and not one clever statement ──
 * The three cases key on different columns, and the second has to *write* a
 * column the first reads. A single `ON CONFLICT` cannot express "conflict on
 * this column, or else that one" — attempting it yields an upsert that
 * silently prefers whichever index the planner reaches first. The unique
 * constraints still settle concurrent races: every write below can lose, and
 * losing is re-read and answered — as the login it has become, or as the
 * refusal it is — rather than surfacing as a 500 or, worse, returning the row
 * as it was before the race.
 *
 * Profile mirroring and the display-name rule are the same as the Firebase
 * path's; see {@link upsertUserFromFirebaseIdentity}.
 */
export async function upsertUserFromWorkosIdentity(
  exec: Executor,
  identity: WorkosIdentity,
): Promise<UpsertedUser> {
  // The brand's runtime half. The type already refuses anything not minted by
  // `workosIdentity()`; this catches the `as` cast and the untyped caller. It is
  // a programming error rather than a refusal, so it is not a RepositoryError:
  // a route should answer it with a 500 and a log line, not a polite 4xx.
  if ((identity as { provider?: unknown }).provider !== 'workos') {
    throw new TypeError(
      'upsertUserFromWorkosIdentity was handed an identity WorkOS did not attest to; ' +
        'construct it with workosIdentity() from the WorkOS API response.',
    );
  }

  // Rule 4 of the linking order, and deliberately before any query: an
  // address the provider has not verified may never reach the linking pass
  // below. Registering an unverified `someone@company.com` at the identity
  // provider would otherwise hand over that person's existing account, with its
  // organisations, its grants and its secrets.
  //
  // The callback checks this too. The duplication is intentional — the
  // callback's check produces the good error message, and this one is the check
  // that is still true after somebody adds a second caller. Nothing above it
  // touches the database.
  if (!identity.emailVerified) {
    throw new RepositoryError(
      'forbidden',
      'The identity provider has not verified this email address.',
    );
  }

  const now = new Date();
  const mirrored = {
    email: identity.email,
    emailVerified: identity.emailVerified,
    avatarUrl: identity.avatarUrl ?? null,
  };

  // ── 1. Known identity ──────────────────────────────────────────────────────
  // Read with soft-deleted rows included. A deleted account that carries this
  // identity is terminal, and has to be refused *here*: filtered out, it would
  // look like nobody, and steps 2 and 3 would go looking for another account
  // to hand the identity instead.
  const known = await findIdentityHolder(exec, identity.subject);
  if (known) {
    // Rule 5: the address may have changed upstream since the last login. The
    // provider is authoritative for it, and a collision is reported exactly as
    // it would be on a fresh signup.
    return { user: await signInLinkedUser(exec, known, mirrored, now), outcome: 'matched' };
  }

  // ── 2. Known address, new identity ─────────────────────────────────────────
  // This branch is what carries every pre-existing account across the provider
  // swap without anybody noticing, and it is the one that has to be airtight.
  //
  // Also read with soft-deleted rows included — `users_email_unique` spans
  // them, so at most one row answers — for the same reason as step 1: a deleted
  // account still holds its address, and without seeing it the insert in step 3
  // would collide with it and report a conflict for what is really a deletion.
  const [holder] = await exec.select().from(users).where(eq(users.email, identity.email)).limit(1);

  // Adoption requires the *same* address, not merely one citext calls equal.
  // Anything else skips adoption, and the insert below is then refused by
  // `users_email_unique` — a conflict, which is the safe answer.
  if (holder && isSameAddress(holder.email, identity.email)) {
    if (holder.deletedAt !== null) {
      // The address belongs to an account that was deleted. Not revived, not
      // re-created around: signing in again is refused exactly as it is for the
      // identity itself.
      throw accountDeleted();
    }

    if (holder.workosUserId === identity.subject) {
      // A concurrent sign-in of this same identity linked the row between step
      // 1's read and this one. From here it is an ordinary login.
      return { user: await signInLinkedUser(exec, holder, mirrored, now), outcome: 'matched' };
    }

    // An address already bound to a *different* provider identity is a
    // conflict, never a relink. Two identities claiming one account is either a
    // provider bug or an attack, and adopting the newer one hands the account
    // over.
    if (holder.workosUserId !== null) throw linkedElsewhere();

    const [linked] = await exec
      .update(users)
      .set({ workosUserId: identity.subject, ...mirrored, updatedAt: now, lastLoginAt: now })
      // Re-asserting "still active, still unlinked" inside the predicate is
      // what makes concurrent first logins safe: the read above is advice, and
      // this is the check. Whoever loses updates nothing and reads no row back.
      .where(and(eq(users.id, holder.id), isNull(users.deletedAt), isNull(users.workosUserId)))
      .returning()
      .catch(rethrowLinkCollision);

    if (linked) return { user: linked, outcome: 'linked' };

    // Lost a race between the read and the write. `holder` is now stale and
    // must not be returned — it is the row as it was *before* somebody else
    // changed it, and handing it back would sign this caller into an account
    // that may now belong to another identity. Re-read and say what happened.
    const current = await findUserIncludingDeleted(exec, holder.id);
    if (!current || current.deletedAt !== null) throw accountDeleted();
    if (current.workosUserId === identity.subject) {
      return { user: await signInLinkedUser(exec, current, mirrored, now), outcome: 'matched' };
    }
    throw linkedElsewhere();
  }

  // ── 3. New account ─────────────────────────────────────────────────────────
  // `DO NOTHING` on the identity, and nothing else: an address collision is
  // still an error (a different identity got there first, or the address only
  // looked like an adoptable one), and it is mapped to a conflict below.
  const [created] = await exec
    .insert(users)
    .values({
      id: uuidv7(),
      workosUserId: identity.subject,
      ...mirrored,
      displayName: identity.displayName ?? null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoNothing({ target: users.workosUserId })
    .returning()
    .catch(rethrowLinkCollision);

  if (created) return { user: created, outcome: 'created' };

  // A concurrent sign-in of this same identity created the row first — a cold
  // start plus a double-clicked button is enough. This request is now an
  // ordinary login into that row, and reports itself as one: `created` twice
  // would audit two sign-ups for one account.
  const winner = await findIdentityHolder(exec, identity.subject);
  if (!winner) throw accountDeleted();
  return { user: await signInLinkedUser(exec, winner, mirrored, now), outcome: 'matched' };
}

/**
 * Whether a stored address and one a provider presented are the same mailbox
 * for the purpose of adopting an account.
 *
 * `email` is citext, and citext folds case with the database's `lower()`. Under
 * a UTF-8 locale that is Unicode case mapping, where distinct strings fold
 * together: the Kelvin sign (U+212A) lowers to an ASCII `k`, and under glibc a
 * dotted capital I (U+0130) lowers to an ASCII `i`. A provider that verifies
 * `Kelly@example.com` has verified a mailbox that is not
 * `kelly@example.com`, and adopting kelly's account on its strength would be
 * the account takeover rule 4 exists to prevent, arriving through the collation
 * instead of the verification flag.
 *
 * So adoption is restricted to what can be decided exactly: the presented
 * address is printable ASCII and the two agree under ASCII-only case folding
 * (which also forces the stored one to be ASCII). Everything else is refused
 * adoption and falls through to an insert the unique constraint turns into a
 * conflict. That is a false negative for a genuinely internationalised address
 * that already has an account — which then needs a human — and never a false
 * positive.
 *
 * @internal Exported for its unit tests.
 */
export function isSameAddress(stored: string, presented: string): boolean {
  return PRINTABLE_ASCII.test(presented) && asciiLowercase(stored) === asciiLowercase(presented);
}

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The row carrying this WorkOS identity, soft-deleted or not. */
async function findIdentityHolder(exec: Executor, workosUserId: string): Promise<User | null> {
  const [row] = await exec
    .select()
    .from(users)
    .where(eq(users.workosUserId, workosUserId))
    .limit(1);
  return row ?? null;
}

async function findUserIncludingDeleted(exec: Executor, userId: string): Promise<User | null> {
  const [row] = await exec.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

/**
 * The ordinary login into a row that already carries the identity: mirror the
 * provider's profile onto it and record the sign-in.
 *
 * A deleted row is refused both before the write and inside it — the second
 * because the account can be deleted between this request's read and its
 * write, and a sign-in must not land on a row that deletion has already ended.
 */
async function signInLinkedUser(
  exec: Executor,
  row: User,
  mirrored: { email: string; emailVerified: boolean; avatarUrl: string | null },
  now: Date,
): Promise<User> {
  if (row.deletedAt !== null) throw accountDeleted();

  const [updated] = await exec
    .update(users)
    .set({ ...mirrored, updatedAt: now, lastLoginAt: now })
    .where(and(eq(users.id, row.id), isNull(users.deletedAt)))
    .returning()
    .catch(rethrowLinkCollision);

  if (!updated) throw accountDeleted();
  return updated;
}

function accountDeleted(): RepositoryError {
  return new RepositoryError(
    'notFound',
    'The account for this identity or this email address was deleted.',
  );
}

function linkedElsewhere(): RepositoryError {
  return new RepositoryError(
    'conflict',
    'That email address is already linked to a different identity.',
  );
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
 * is gone. What ends is the *account*: both sign-in paths refuse a soft-deleted
 * row — `upsertUserFromFirebaseIdentity` through `setWhere`, and the WorkOS
 * linking pass by reading deleted rows specifically to refuse them, whether it
 * reaches the row by identity or by address — so neither provider's identity
 * can sign in to it again, and its address cannot be re-registered around it.
 * The caller is responsible for what surrounds the row — sessions, tokens,
 * memberships — which is `deleteAccount` in the web layer, inside one
 * transaction with this.
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
 * A provider account whose email address changes can collide with an existing
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

/**
 * {@link rethrowEmailCollision}, plus the linking pass's second constraint.
 *
 * Writing `workos_user_id` onto an adopted row loses to any concurrent write of
 * the same id to another row — the same identity being created by a parallel
 * request. That is a race lost, not a server fault, and it is answered as the
 * conflict it is rather than as a 500.
 */
function rethrowLinkCollision(error: unknown): never {
  if (isUniqueViolation(error, WORKOS_USER_ID_UNIQUE_CONSTRAINT)) {
    throw new RepositoryError(
      'conflict',
      'This sign-in identity is already linked to another account.',
    );
  }
  return rethrowEmailCollision(error);
}
