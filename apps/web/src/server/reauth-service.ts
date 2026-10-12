import {
  generateToken,
  hashToken,
  IdentityVerificationError,
  isWellFormedToken,
} from '@xecret/core/auth';
import {
  consumeReauthProof,
  findFreshSignIn,
  findUserById,
  issueReauthProof,
  markReauthCodeSent,
  recordReauthCodeFailure,
} from '@xecret/db/repositories';
import type { Reauthentication } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import {
  REAUTH_MAX_CODE_FAILURES,
  REAUTH_SIGN_IN_MAX_AGE_SECONDS,
  VAULT_RESET_MAX_REAUTH_AGE_SECONDS,
} from './schemas/vault';
import { IdentityProviderUnavailableError, workosProvider } from './workos';

/**
 * Re-authentication for the vault reset — two locks on one irreversible door.
 *
 * The reset destroys a vault and every key sealed under it, permanently, and it
 * has to stay reachable from a locked session because every caller of it is
 * locked out by definition. What stands in front of it instead of the vault lock
 * is the decision recorded in `.local/workos-auth.md` §8 Q5: **both** a fresh
 * sign-in **and** an emailed one-time code, **in that order**.
 *
 *  1. **The fresh sign-in.** The browser goes through AuthKit again with
 *     `max_age=0`, so a session AuthKit still holds does not satisfy it, and the
 *     callback records the sign-in against the brand-new xecret session it
 *     issues (`recordFreshSignIn`, from `server/sign-in.ts`). Only a sign-in
 *     that presented a real credential counts — a password, a passkey, an OAuth
 *     account or the company's SSO. One completed with an emailed code is
 *     refused for this purpose, or the two locks would be one inbox twice.
 *  2. **The emailed code** — WorkOS Magic Auth. Requested and verified only
 *     while the sign-in is under {@link REAUTH_SIGN_IN_MAX_AGE_SECONDS} old,
 *     only by the session that sign-in issued, and only for the WorkOS user that
 *     session's account is linked to.
 *  3. **The proof.** A verified code mints a one-time, five-minute token bound
 *     to the session and the user. The reset spends it atomically.
 *
 * What each lock answers. The sign-in alone would leave a stolen live session
 * one click from destroying an organisation's keys, if AuthKit's own session
 * came with it. The code alone would reduce the most destructive button in the
 * product to the strength of somebody's inbox. Together, an attacker needs the
 * credential *and* the mailbox, and needs them now.
 *
 * Every refusal here is a 403 and never a 401: the client's API layer treats a
 * 401 as "your session has ended" and bounces to the sign-in page, which would
 * throw away the very session the attempt is bound to.
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

export interface ReauthStatus {
  /** Whether this session's fresh sign-in is recent enough to ask for a code. */
  signedIn: boolean;
  /** When that stops being true, or `null`. */
  signedInUntil: Date | null;
  /** Whether a code has been requested for this attempt. */
  codeSent: boolean;
}

/** Where this session's attempt stands. Reads only; never sends anything. */
export async function reauthStatus(
  services: ServiceContext,
  user: UserPrincipal,
  now: Date = new Date(),
): Promise<ReauthStatus> {
  const attempt = await currentAttempt(services, user, now);
  if (attempt === null) return { signedIn: false, signedInUntil: null, codeSent: false };
  return {
    signedIn: true,
    signedInUntil: new Date(attempt.signedInAt.getTime() + REAUTH_SIGN_IN_MAX_AGE_SECONDS * 1000),
    codeSent: attempt.codeSentAt !== null,
  };
}

/**
 * Lock two, first half: has WorkOS email a one-time code to this account.
 *
 * WorkOS emails the code itself; the copy in its response is dropped unread by
 * `WorkosIdentityProvider.createMagicAuth`, so it never reaches a log, a
 * response or a row here. That needs Magic Auth enabled in the WorkOS
 * environment — while it is off, WorkOS refuses the call and this answers 503.
 *
 * The address is always the one on this account's own row, so the mail can
 * only ever go to the account's own inbox. The check that the address still
 * reaches the WorkOS user this account is linked to runs after the call,
 * because only the call says which user that is; on a mismatch the code sits
 * in the owner's inbox unusable, since verification checks the same thing.
 *
 * Refused unless lock one is in place. That is the order the decision asks
 * for, and it also means nobody can make xecret email an account without first
 * signing in as it.
 */
export async function startReauth(
  services: ServiceContext,
  user: UserPrincipal,
  now: Date = new Date(),
): Promise<void> {
  const attempt = await currentAttempt(services, user, now);
  if (attempt === null) throw signInAgain();

  const workosUserId = await linkedWorkosUser(services, user);

  let created: { workosUserId: string };
  try {
    created = await workosProvider(services.env).createMagicAuth(user.user.email, {
      ipAddress: services.meta.ipAddress,
      userAgent: services.meta.userAgent,
    });
  } catch (cause) {
    throw mapProviderFailure(services, cause, 'createMagicAuth');
  }

  // The address on our row and the WorkOS user it reaches must be the account
  // this session belongs to. If they have drifted apart — an address changed
  // at WorkOS since the last sign-in — the code would prove control of somebody
  // else's inbox, so nothing more is done with it.
  if (created.workosUserId !== workosUserId) {
    services.log
      .at('startReauth')
      .warn('Refused to continue a re-authentication: the address reaches a different WorkOS user');
    throw signInAgain();
  }

  await markReauthCodeSent(services.db, attempt.id, now);
}

/**
 * Lock two, second half: checks the code, and mints the proof the reset spends.
 *
 * The proof is a 256-bit token, returned once, stored only as its SHA-256 and
 * bound to this session and this user. A second successful verification
 * replaces the first proof rather than adding one.
 */
export async function verifyReauth(
  services: ServiceContext,
  user: UserPrincipal,
  code: string,
  now: Date = new Date(),
): Promise<{ proof: string; expiresAt: Date }> {
  const attempt = await currentAttempt(services, user, now);
  if (attempt === null) throw signInAgain();

  const workosUserId = await linkedWorkosUser(services, user);

  let verified: { workosUserId: string; impersonated: boolean };
  try {
    verified = await workosProvider(services.env).authenticateWithMagicAuth(
      { code, email: user.user.email },
      { ipAddress: services.meta.ipAddress, userAgent: services.meta.userAgent },
    );
  } catch (cause) {
    if (cause instanceof IdentityVerificationError) {
      // A wrong, expired or reused code. Counted before answering, so the
      // allowance is spent whether or not the client waits for the reply.
      await recordReauthCodeFailure(services.db, attempt.id);
      services.log
        .at('verifyReauth')
        .warn(
          'Refused a re-authentication code — this attempt has now failed ' +
            `${attempt.codeFailures + 1} time(s) of ${REAUTH_MAX_CODE_FAILURES}`,
          { reason: cause.reason, failures: attempt.codeFailures + 1 },
        );
      throw errors.forbidden(
        'That code is not right, or it has expired. Check the email, or send a new code.',
      );
    }
    throw mapProviderFailure(services, cause, 'authenticateWithMagicAuth');
  }

  if (verified.impersonated || verified.workosUserId !== workosUserId) {
    services.log
      .at('verifyReauth')
      .warn('Refused a re-authentication code that did not prove control of this account', {
        impersonated: verified.impersonated,
      });
    throw signInAgain();
  }

  const { token, hash } = await generateToken('reauthProof');
  const expiresAt = new Date(now.getTime() + VAULT_RESET_MAX_REAUTH_AGE_SECONDS * 1000);
  const recorded = await issueReauthProof(services.db, {
    userId: user.user.id,
    sessionId: user.sessionId,
    signedInSince: signedInSince(now),
    maxCodeFailures: REAUTH_MAX_CODE_FAILURES,
    proofHash: hash,
    expiresAt,
  });
  // The attempt aged out, ran out of tries or was spent between the read above
  // and this write. The proof was never recorded, so it is never handed out.
  if (!recorded) throw signInAgain();

  return { proof: token, expiresAt };
}

/**
 * The reset's gate: spends a proof, or refuses.
 *
 * One atomic UPDATE (`consumeReauthProof`) decides it — this proof, this user,
 * this session, unspent, unexpired — so two concurrent resets with one proof
 * cannot both pass. The proof is spent *before* the reset runs: a reset that
 * then fails for another reason needs a fresh proof, which is the safe way for
 * a one-time credential to fail.
 *
 * Every failure is the same refusal with the same message: naming which part
 * was wrong tells somebody holding a stolen proof which part to fix.
 */
export async function assertRecentAccountOwner(
  services: ServiceContext,
  user: UserPrincipal,
  reauthProof: string,
  now: Date = new Date(),
): Promise<void> {
  const refuse = (reason: string): never => {
    services.log
      .at('assertRecentAccountOwner')
      .warn(
        `Refused a vault reset because the re-authentication proof was ${reason}. The caller ` +
          'was told only to confirm it is them again.',
        { reason },
      );
    throw errors.forbidden(
      'Confirm it’s you again — sign in, then enter the emailed code — before resetting your vault.',
    );
  };

  if (!isWellFormedToken(reauthProof, 'reauthProof')) return refuse('malformed');

  const spent = await consumeReauthProof(services.db, {
    userId: user.user.id,
    sessionId: user.sessionId,
    proofHash: await hashToken(reauthProof),
    now,
  });
  if (!spent) return refuse('unknown, spent, expired or not this session’s');
}

/** This session's live attempt, or `null`. */
async function currentAttempt(
  services: ServiceContext,
  user: UserPrincipal,
  now: Date,
): Promise<Reauthentication | null> {
  return findFreshSignIn(services.db, {
    userId: user.user.id,
    sessionId: user.sessionId,
    signedInSince: signedInSince(now),
    maxCodeFailures: REAUTH_MAX_CODE_FAILURES,
  });
}

function signedInSince(now: Date): Date {
  return new Date(now.getTime() - REAUTH_SIGN_IN_MAX_AGE_SECONDS * 1000);
}

/**
 * The WorkOS user this account is linked to. Always present after a fresh
 * sign-in — the callback that recorded it linked the account — so its absence
 * means the account changed underneath the attempt.
 */
async function linkedWorkosUser(services: ServiceContext, user: UserPrincipal): Promise<string> {
  const row = await findUserById(services.db, user.user.id);
  if (row === null || row.workosUserId === null) throw signInAgain();
  return row.workosUserId;
}

function signInAgain() {
  return errors.forbidden('Sign in again to confirm it’s you, then request a new code.');
}

function mapProviderFailure(services: ServiceContext, cause: unknown, call: string): unknown {
  if (cause instanceof IdentityProviderUnavailableError) {
    services.log
      .at('reauth')
      .error(
        `WorkOS was ${cause.reason} during ${call}; vault-reset re-authentication is unavailable`,
        {
          reason: cause.reason,
        },
      );
    return cause.reason === 'rate-limited'
      ? errors.rateLimited()
      : errors.unavailable(`workos ${cause.reason}`);
  }
  if (cause instanceof IdentityVerificationError) {
    services.log.at('reauth').warn(`WorkOS refused ${call}`, { reason: cause.reason });
    return signInAgain();
  }
  return cause;
}
