import { and, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { hashToken, sessionExpiryFrom } from '@xecret/core/auth';
import type { SessionRecord } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { sessions, users } from '../schema/identity';
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
  });

  return record;
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
 * @internal Exported so `identity.test.ts` can assert the shape of the SQL — the
 * tenancy and revocation predicates on this query are security controls, and a
 * refactor that drops one should fail a test rather than pass review.
 */
export function sessionLookupQuery(exec: Executor, tokenHash: Uint8Array, now: Date) {
  return exec
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      revokedAt: sessions.revokedAt,
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
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
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
