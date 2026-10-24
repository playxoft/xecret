import { and, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { hashToken, sessionExpiryFrom } from '@xecret/core/auth';
import type { SessionRecord } from '@xecret/core/auth';
import type { SignInMethod } from '@xecret/core/audit';
import { uuidv7 } from '@xecret/core/ids';
import { sessions, signInConfirmations, users } from '../schema/identity';
import { userKeys } from '../schema/vault';
import { MAX_PAGE_SIZE } from './shared';
import type { Executor } from './shared';

/**
 * Sessions. The policy lives in `@xecret/core/auth`; this module only stores.
 *
 * That split is deliberate. SQL here prunes the rows that are cheap and indexed
 * to exclude — revoked, and past their absolute expiry — while `evaluateSession`
 * makes the final call, including the idle timeout. So there is exactly one
 * definition of "a valid session", it is unit-tested without a database, and
 * changing the policy never means editing a `WHERE` clause in this file.
 *
 * Nothing here accepts or returns a raw session token. The caller hashes on the
 * way in and already holds the token it issued; a token that never enters this
 * module cannot be logged, returned, or written by it (threat T6).
 */

/** The user fields a request handler needs to render the actor, and no more. */
export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A session row plus its owner, as resolved on the authenticated hot path. */
export interface AuthenticatedSession extends SessionRecord {
  user: SessionUser;
  /**
   * When this session last unlocked its owner's vault, or `null` for never.
   *
   * Carried on the hot-path lookup rather than fetched separately, because every
   * request that resolves a session also has to decide whether it is unlocked —
   * a second query for one timestamp would be a round trip per request forever.
   */
  vaultUnlockedAt: Date | null;
  /**
   * The owner's auto-lock preference, or `null` for "no vault, or no preference".
   *
   * Here for the same reason `vaultUnlockedAt` is, and it is the other half of
   * the same decision: since the unlock window *is* this preference, a request
   * that resolves a session cannot tell whether it is unlocked without it. A
   * second query for one integer would be a round trip per request forever, so
   * it rides along on the join that is already happening.
   */
  vaultAutoLockMinutes: number | null;
  /**
   * How the sign-in that issued this session authenticated, or `null` for a
   * session issued before migration 0022 recorded it.
   */
  signInMethod: SignInMethod | null;
  /**
   * The WorkOS organisation whose single sign-on issued this session, or
   * `null`. What an organisation's `sso_required` is checked against on every
   * request — see `resolveOrg`. Rides on the lookup join for the reason
   * `vaultUnlockedAt` does.
   */
  ssoWorkosOrgId: string | null;
}

/**
 * A session as shown in the active-devices list.
 *
 * Extends `SessionRecord` so each row can be handed straight to
 * `evaluateSession` to decide whether the device is still signed in — the UI
 * gets the idle rule for free instead of this module growing a second copy of it.
 */
export interface SessionDevice extends SessionRecord {
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface CreateSessionParams {
  userId: string;
  /** The raw token. Hashed here; only the hash is ever written. */
  token: string;
  /** From the edge, not from a client-controlled header. `null` when unknown. */
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * How the sign-in authenticated. Omitted means not known, which every reader
   * treats as "not single sign-on" — the restrictive answer, so leaving it out
   * can only ever cost access, never grant it.
   */
  signInMethod?: SignInMethod | null | undefined;
  /** The WorkOS organisation whose single sign-on this was. Only beside `sso`. */
  ssoWorkosOrgId?: string | null | undefined;
  /**
   * The AuthKit session the sign-in came from (the access token's `sid`), so
   * sign-out can end it too. Omitted: sign-out ends only this session.
   */
  workosSessionId?: string | null | undefined;
  /**
   * When the person actively authenticated for the re-authentication that
   * issues this session — what the SSO setup portal's step-up reads. Omitted
   * for every sign-in that was not one.
   */
  freshAuthAt?: Date | null | undefined;
}

/**
 * Issues a session for an already-authenticated user.
 *
 * Returns the record without the token or its hash: the caller minted the token
 * and is the only party that needs it, so handing it back would only widen the
 * set of places it can be dropped.
 */
export async function createSession(
  exec: Executor,
  params: CreateSessionParams,
): Promise<SessionRecord> {
  const now = new Date();
  const record: SessionRecord = {
    id: uuidv7(),
    userId: params.userId,
    expiresAt: sessionExpiryFrom(now),
    lastSeenAt: now,
    revokedAt: null,
  };

  // Every column this returns is written here rather than defaulted by the
  // database, so there is nothing to read back with `RETURNING`.
  await exec.insert(sessions).values({
    id: record.id,
    userId: record.userId,
    tokenHash: await hashToken(params.token),
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    createdAt: now,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    signInMethod: params.signInMethod ?? null,
    ssoWorkosOrgId: params.ssoWorkosOrgId ?? null,
    workosSessionId: params.workosSessionId ?? null,
    freshAuthAt: params.freshAuthAt ?? null,
  });

  return record;
}

/**
 * When this session's own sign-in was a fresh authentication — a
 * re-authentication, by any method that re-proves who the person is — or
 * `null` (migration 0023). Keyed on the session *and* the user, as
 * `findFreshSignIn` is, so the answer cannot be about somebody else.
 *
 * Revoked and expired sessions answer `null`: the caller is asking about the
 * session presenting the request, which an authenticated route has already
 * resolved, and a stale row must not stand in for it.
 */
export async function findSessionFreshAuth(
  exec: Executor,
  params: { sessionId: string; userId: string },
  now = new Date(),
): Promise<Date | null> {
  const [row] = await exec
    .select({ freshAuthAt: sessions.freshAuthAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, params.sessionId),
        eq(sessions.userId, params.userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row?.freshAuthAt ?? null;
}

/**
 * Resolves a request's actor from the hash of its session cookie.
 *
 * One query. The user is joined rather than fetched afterwards because this runs
 * on every authenticated request, and a second round trip to the database is a
 * cost paid per request forever.
 *
 * `revoked_at IS NULL` is load-bearing twice over: it is the correctness filter,
 * and it is what makes the partial index `sessions_lookup_idx` usable at all —
 * PostgreSQL only chooses a partial index when the query implies its predicate.
 * One consequence worth knowing: a revoked session is reported by
 * `evaluateSession` as `unknown` rather than `revoked`, because it never leaves
 * the database. The audit trail of the revocation itself carries that detail.
 *
 * Soft-deleted users are excluded in the join, so deleting an account kills its
 * live sessions immediately instead of at their next expiry.
 */
export async function findSessionByTokenHash(
  exec: Executor,
  tokenHash: Uint8Array,
  now = new Date(),
): Promise<AuthenticatedSession | null> {
  const [row] = await sessionLookupQuery(exec, tokenHash, now);
  return row ?? null;
}

/**
 * Updates `last_seen_at`, nothing else.
 *
 * Whether this is worth a write is `shouldTouchSession`'s decision, not this
 * module's: re-deriving the interval in SQL would put the same rule in two
 * places, and they would eventually disagree.
 */
export async function touchSession(exec: Executor, sessionId: string, now: Date): Promise<void> {
  await exec
    .update(sessions)
    .set({ lastSeenAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/**
 * Records that this session just unlocked its owner's vault.
 *
 * Written to the session rather than to the user, so unlocking on a desktop does
 * not silently unlock the phone that is also signed in. Each device proves
 * presence for itself, which is the only reading under which "somebody is
 * sitting at this machine" means anything.
 */
export async function markSessionUnlocked(
  exec: Executor,
  sessionId: string,
  now: Date,
): Promise<void> {
  await exec
    .update(sessions)
    .set({ vaultUnlockedAt: now, lastSeenAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/**
 * Locks a session without ending it.
 *
 * Clearing the timestamp rather than revoking the row is the whole point of the
 * feature: the user stays signed in for their 30 days and simply has to prove
 * presence again. Revoking would send them back through a full sign-in at WorkOS
 * AuthKit, which is the cost this design exists to avoid.
 *
 * `userId` locks every session the account has — "lock everywhere", for a laptop
 * left behind rather than lost.
 */
export async function lockSessions(
  exec: Executor,
  target: { sessionId: string } | { userId: string },
): Promise<number> {
  const scope =
    'sessionId' in target ? eq(sessions.id, target.sessionId) : eq(sessions.userId, target.userId);

  const result = await exec
    .update(sessions)
    .set({ vaultUnlockedAt: null })
    .where(and(scope, isNull(sessions.revokedAt)));

  return result.count;
}

/**
 * Revokes one session. Idempotent.
 *
 * The `revoked_at IS NULL` guard keeps a repeated call from rewriting the
 * timestamp of a session that was already revoked, which would misdate the
 * moment access actually ended — the one fact an incident review needs.
 *
 * Returns whether this call was the one that revoked it, so a caller can avoid
 * writing a duplicate audit record.
 */
export async function revokeSession(exec: Executor, sessionId: string): Promise<boolean> {
  const result = await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

  return result.count > 0;
}

/**
 * Sign-out: revokes one session, as {@link revokeSession} does, and answers
 * the AuthKit session its sign-in came from (`workos_session_id`, migration
 * 0023) so the caller can end that too — or `null` when this call revoked
 * nothing (already revoked) or the session recorded none.
 *
 * One statement, so the id comes from the row this call actually revoked: a
 * second sign-out of the same session answers `revoked: false` and no id, and
 * cannot hand out a logout URL for a session somebody else already ended.
 */
export async function revokeSessionForSignOut(
  exec: Executor,
  sessionId: string,
): Promise<{ revoked: boolean; workosSessionId: string | null }> {
  const rows = await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ workosSessionId: sessions.workosSessionId });
  const [row] = rows;
  return { revoked: row !== undefined, workosSessionId: row?.workosSessionId ?? null };
}

/**
 * Signs a user out everywhere, optionally sparing the session making the request.
 *
 * Returns how many sessions were revoked so the audit record can state it: "4
 * other sessions signed out" is the confirmation a user needs after a password
 * change or a lost laptop.
 */
export async function revokeAllUserSessions(
  exec: Executor,
  userId: string,
  options?: { exceptSessionId?: string | undefined },
): Promise<number> {
  const result = await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        options?.exceptSessionId === undefined
          ? undefined
          : ne(sessions.id, options.exceptSessionId),
      ),
    );

  return result.count;
}

/** Active devices for the account-security screen. */
export async function listUserSessions(exec: Executor, userId: string): Promise<SessionDevice[]> {
  return userSessionsQuery(exec, userId);
}

/**
 * Deletes sessions that expired before `before`. For a scheduled worker.
 *
 * Retention is the caller's choice — expired rows are still evidence for a while
 * ("which device was signed in when this secret was read?"), so this deletes on
 * the schedule an operator sets rather than at the moment of expiry.
 */
export async function deleteExpiredSessions(exec: Executor, before: Date): Promise<number> {
  const result = await exec.delete(sessions).where(lt(sessions.expiresAt, before));
  return result.count;
}

/**
 * Spends a sign-in confirmation, once: records the SHA-256 of the nonce its
 * sealed cookie carried, and answers whether this call was the one that did.
 *
 * The primary key is the whole mechanism. Two requests presenting the same
 * cookie — a double click, a replay — race on one INSERT, and exactly one gets
 * its row back; the other is refused before anything is issued. Called before
 * the session is, so a confirmation that then fails for another reason is
 * spent all the same: the safe way for a one-time value to fail.
 */
export async function spendSignInConfirmation(
  exec: Executor,
  params: { nonceHash: Uint8Array; userId: string; expiresAt: Date },
): Promise<boolean> {
  const rows = await exec
    .insert(signInConfirmations)
    .values({ nonceHash: params.nonceHash, userId: params.userId, expiresAt: params.expiresAt })
    .onConflictDoNothing({ target: signInConfirmations.nonceHash })
    .returning({ userId: signInConfirmations.userId });
  return rows.length > 0;
}

/**
 * Deletes spent confirmations whose cookies expired before `before`. For a
 * scheduled worker: such a row can no longer stop anything, because the cookie
 * it guards is refused on its age first.
 */
export async function deleteSpentSignInConfirmations(
  exec: Executor,
  before: Date,
): Promise<number> {
  const rows = await exec
    .delete(signInConfirmations)
    .where(lt(signInConfirmations.expiresAt, before))
    .returning({ userId: signInConfirmations.userId });
  return rows.length;
}

/**
 * @internal Exported so `identity.test.ts` can assert the shape of the SQL — the
 * tenancy and revocation predicates on this query are security controls, and a
 * refactor that drops one should fail a test rather than pass review.
 */
export function sessionLookupQuery(exec: Executor, tokenHash: Uint8Array, now: Date) {
  return (
    exec
      .select({
        id: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        revokedAt: sessions.revokedAt,
        vaultUnlockedAt: sessions.vaultUnlockedAt,
        vaultAutoLockMinutes: userKeys.autoLockMinutes,
        signInMethod: sessions.signInMethod,
        ssoWorkosOrgId: sessions.ssoWorkosOrgId,
        user: {
          id: users.id,
          email: users.email,
          emailVerified: users.emailVerified,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
        },
      })
      .from(sessions)
      .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.deletedAt)))
      // LEFT, and one column. An account with no vault has no row here and must
      // still resolve — it is on its way to the setup ceremony. `user_keys` is
      // deliberately not part of `users` (see its schema header) because eleven
      // columns on the hot path is a cost paid forever; one integer on a
      // primary-key equality is what the unlock gate costs instead of a second
      // query per request.
      .leftJoin(userKeys, eq(userKeys.userId, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1)
  );
}

/**
 * @internal Exported for the same reason as `sessionLookupQuery`.
 *
 * The columns are listed explicitly so `token_hash` cannot be selected here.
 * There is no legitimate reason for that column to leave the database, and a
 * column list is a cheaper thing to review — and to assert on — than a
 * redaction step applied after the fact.
 *
 * Bounded by `MAX_PAGE_SIZE`: sessions accumulate over a 30-day lifetime, and an
 * unbounded read of them would run in a Worker with a 128 MB ceiling. Ordering
 * by `last_seen_at` puts the devices a user would recognise first.
 */
export function userSessionsQuery(exec: Executor, userId: string) {
  return exec
    .select({
      id: sessions.id,
      userId: sessions.userId,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(MAX_PAGE_SIZE);
}
