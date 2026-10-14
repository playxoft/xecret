import {
  generateToken,
  hashToken,
  IdentityVerificationError,
  isWellFormedToken,
} from '@xecret/core/auth';
import { timingSafeEqual } from '@xecret/core/crypto';
import {
  consumeReauthProof,
  findFreshSignIn,
  findUserById,
  issueReauthProof,
  markReauthCodeSent,
  recordReauthMfaPending,
  reserveReauthCodeSend,
  reserveReauthGuess,
  toBytes,
} from '@xecret/db/repositories';
import type { Reauthentication } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { ApiError, errors } from './errors';
import {
  REAUTH_MAX_CODE_ATTEMPTS,
  REAUTH_MAX_CODE_SENDS,
  REAUTH_MAX_USER_ATTEMPTS,
  REAUTH_SIGN_IN_MAX_AGE_SECONDS,
  REAUTH_USER_WINDOW_SECONDS,
  VAULT_RESET_MAX_REAUTH_AGE_SECONDS,
} from './schemas/vault';
import type { ReauthVerifyRequest } from './schemas/vault';
import {
  AuthenticationStepRequired,
  IdentityProviderUnavailableError,
  workosProvider,
} from './workos';
import type { AuthenticationStepCode } from './workos';

/**
 * Re-authentication for the vault reset — two locks on one irreversible door.
 *
 * The reset destroys a vault and every key sealed under it, permanently, and it
 * has to stay reachable from a locked session because every caller of it is
 * locked out by definition. What stands in front of it instead of the vault lock
 * is the decision recorded in `.local/workos-auth.md` §8 Q5: **both** a fresh
 * sign-in **and** an emailed one-time code, **in that order**.
 *
 *  1. **The fresh sign-in.** The browser goes through AuthKit again, and the
 *     callback records the sign-in against the brand-new xecret session it
 *     issues (`recordFreshSignIn`, from `server/sign-in.ts`) — only for the
 *     methods listed in `REAUTHENTICATING_METHODS` there. **How fresh that is
 *     depends on the method**, and the honest account is in ADR 0010: AuthKit's
 *     `max_age=0` makes AuthKit itself ask for a password or a passkey again,
 *     but WorkOS documents it only for its own screens. It does not make Google
 *     or a company's identity provider re-prompt, so for those users a live
 *     Google or SSO session in the same browser satisfies lock one silently.
 *     What the server does check is that an authentication happened during
 *     the flow at all — WorkOS's `auth_time` (`armsLockOne`) — so a reused
 *     AuthKit session, with `max_age=0` stripped, is not lock one.
 *  2. **The emailed code** — WorkOS Magic Auth. Requested and checked only
 *     while the sign-in is under {@link REAUTH_SIGN_IN_MAX_AGE_SECONDS} old,
 *     only by the session that sign-in issued, and only for the WorkOS user that
 *     session's account is linked to. When WorkOS also wants the user's
 *     authenticator (`mfa_challenge`), that is completed here too, with TOTP.
 *  3. **The proof.** A verified code mints a one-time, five-minute token bound
 *     to the session and the user. The reset spends it atomically.
 *
 * ── Guessing ──
 * The code is six digits, so every guess — at the emailed code and at the
 * authenticator code alike — is reserved before WorkOS is asked
 * (`reserveReauthGuess`): at most {@link REAUTH_MAX_CODE_ATTEMPTS} per attempt
 * and {@link REAUTH_MAX_USER_ATTEMPTS} per account in any
 * {@link REAUTH_USER_WINDOW_SECONDS}, however the guesses are spread over fresh
 * sign-ins, sessions or concurrent requests, and whatever WorkOS answers. Ten
 * guesses a day at a six-digit code is a one-in-a-hundred-thousand chance a
 * day; the rate limiter sits in front of that and fails open, this does not.
 * Asking for the code is capped the same way, before WorkOS is asked to send
 * it: {@link REAUTH_MAX_CODE_SENDS} per attempt, so lock one cannot be turned
 * into a stream of mail to somebody's inbox.
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
 * signing in as it. And capped: each request is reserved against
 * {@link REAUTH_MAX_CODE_SENDS} before WorkOS is asked (`reserveReauthCodeSend`),
 * so a burst of requests sends no more than that between them, and a request
 * WorkOS then refuses still counts.
 */
export async function startReauth(
  services: ServiceContext,
  user: UserPrincipal,
  now: Date = new Date(),
): Promise<void> {
  const workosUserId = await linkedWorkosUser(services, user);

  const reservation = await reserveReauthCodeSend(services.db, {
    userId: user.user.id,
    sessionId: user.sessionId,
    signedInSince: signedInSince(now),
    maxAttempts: REAUTH_MAX_CODE_ATTEMPTS,
    maxSends: REAUTH_MAX_CODE_SENDS,
  });
  if (!reservation.ok) {
    services.log
      .at('startReauth')
      .warn('Refused a re-authentication code request before asking WorkOS', {
        reason: reservation.reason,
      });
    throw reservation.reason === 'send-budget' ? codesUsedUp() : signInAgain();
  }
  const { attempt } = reservation;

  let created: { workosUserId: string };
  try {
    created = await workosProvider(services.env).createMagicAuth(user.user.email, {
      ipAddress: services.meta.ipAddress,
      userAgent: services.meta.userAgent,
    });
  } catch (cause) {
    // A plain refusal of the request to *send* a code is not "wrong code".
    if (
      cause instanceof IdentityVerificationError &&
      !(cause instanceof AuthenticationStepRequired)
    ) {
      services.log
        .at('startReauth')
        .warn('WorkOS refused createMagicAuth', { reason: cause.reason });
      throw signInAgain();
    }
    throw refusalFor(services, cause, 'createMagicAuth');
  }

  if (created.workosUserId !== workosUserId) {
    services.log
      .at('startReauth')
      .warn('Refused to continue a re-authentication: the address reaches a different WorkOS user');
    throw signInAgain();
  }

  await markReauthCodeSent(services.db, attempt.id, now);
}

export type ReauthVerification =
  /** Both locks open: the proof the reset spends. */
  | { kind: 'proof'; proof: string; expiresAt: Date }
  /**
   * The emailed code was right, and WorkOS wants the user's authenticator too.
   * `mfaToken` is WorkOS's pending-authentication token: handed to the browser,
   * which sends it back with the TOTP code, and kept here only as its hash.
   */
  | { kind: 'mfa'; mfaToken: string };

/**
 * Lock two, second half: checks a guess — the emailed code, or the
 * authenticator code WorkOS asked for after it — and mints the proof the reset
 * spends.
 *
 * The guess is reserved against both budgets **first** (`reserveReauthGuess`),
 * so it costs the same whatever WorkOS answers and however many arrive at once.
 * The proof is a 256-bit token, returned once, stored only as its SHA-256 and
 * bound to this session and this user. A second success replaces the first
 * proof rather than adding one.
 */
export async function verifyReauth(
  services: ServiceContext,
  user: UserPrincipal,
  guess: ReauthVerifyRequest,
  now: Date = new Date(),
): Promise<ReauthVerification> {
  const workosUserId = await linkedWorkosUser(services, user);

  const reservation = await reserveReauthGuess(services.db, {
    userId: user.user.id,
    sessionId: user.sessionId,
    signedInSince: signedInSince(now),
    maxAttempts: REAUTH_MAX_CODE_ATTEMPTS,
    maxUserAttempts: REAUTH_MAX_USER_ATTEMPTS,
    userWindowSince: new Date(now.getTime() - REAUTH_USER_WINDOW_SECONDS * 1000),
  });
  if (!reservation.ok) {
    services.log.at('verifyReauth').warn('Refused a re-authentication guess before asking WorkOS', {
      reason: reservation.reason,
    });
    throw reservation.reason === 'user-budget' ? errors.reauthBudgetSpent() : signInAgain();
  }
  const { attempt } = reservation;
  const provider = workosProvider(services.env);
  const context = { ipAddress: services.meta.ipAddress, userAgent: services.meta.userAgent };

  let verified: { workosUserId: string; impersonated: boolean };
  try {
    if ('totp' in guess) {
      // Only the authenticator step this attempt is waiting for: the token must
      // be the one WorkOS handed out for *this* attempt's emailed code.
      if (attempt.mfaPendingHash === null || attempt.mfaFactorId === null) throw signInAgain();
      const presented = await hashToken(guess.mfaToken);
      if (!timingSafeEqual(presented, toBytes(attempt.mfaPendingHash))) throw signInAgain();

      verified = await provider.completeWithTotp(
        {
          code: guess.totp,
          pendingAuthenticationToken: guess.mfaToken,
          totpFactorId: attempt.mfaFactorId,
        },
        context,
      );
    } else {
      verified = await provider.authenticateWithMagicAuth(
        { code: guess.code, email: user.user.email },
        context,
      );
    }
  } catch (cause) {
    if (
      cause instanceof AuthenticationStepRequired &&
      cause.code === 'mfa_challenge' &&
      !('totp' in guess) &&
      cause.pendingAuthenticationToken !== null &&
      cause.totpFactorId !== null
    ) {
      // The emailed code was right; the authenticator comes next.
      const recorded = await recordReauthMfaPending(services.db, {
        id: attempt.id,
        pendingHash: await hashToken(cause.pendingAuthenticationToken),
        factorId: cause.totpFactorId,
      });
      if (!recorded) throw signInAgain();
      return { kind: 'mfa', mfaToken: cause.pendingAuthenticationToken };
    }
    throw refusalFor(
      services,
      cause,
      'totp' in guess ? 'authenticateWithTotp' : 'authenticateWithMagicAuth',
    );
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
    proofHash: hash,
    expiresAt,
  });
  // The attempt aged out or was spent between the reservation and this write.
  // The proof was never recorded, so it is never handed out.
  if (!recorded) throw signInAgain();

  return { kind: 'proof', proof: token, expiresAt };
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
    maxAttempts: REAUTH_MAX_CODE_ATTEMPTS,
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

function codesUsedUp() {
  return errors.forbidden(
    'That’s as many codes as one sign-in can send. Sign in again to confirm it’s you, then request a new code.',
  );
}

/**
 * What a person is told when WorkOS answered with a step this page cannot
 * take. Each is specific, because "that code is wrong" for a right code is
 * the one answer that sends somebody round in circles.
 */
const STEP_MESSAGES: Record<AuthenticationStepCode, string> = {
  mfa_challenge:
    'Your account’s second factor isn’t an authenticator app, which is the only kind this step can use. Contact support to reset your vault.',
  mfa_verification: 'That authenticator code is not right. Try the current one.',
  mfa_enrollment:
    'Your account needs multi-factor authentication set up first. Sign in once to set it up, then try again.',
  organization_selection_required:
    'Your sign-in account belongs to more than one organisation, so an emailed code can’t confirm it here. Contact support to reset your vault.',
  email_verification_required:
    'Verify your email address on the sign-in page first, then try again.',
  sso_required:
    'Your organisation requires its single sign-on, so an emailed code can’t confirm it’s you. Ask your administrator for help.',
  organization_authentication_methods_required:
    'Your organisation requires its single sign-on, so an emailed code can’t confirm it’s you. Ask your administrator for help.',
  radar_email_challenge:
    'The sign-in service asked for an extra check this page can’t show. Wait a while, then try again.',
  radar_sms_challenge:
    'The sign-in service asked for an extra check this page can’t show. Wait a while, then try again.',
};

/** Turns a WorkOS failure into the answer the person gets, logging what really happened. */
function refusalFor(services: ServiceContext, cause: unknown, call: string): unknown {
  const log = services.log.at('reauth');
  if (cause instanceof ApiError) return cause;
  if (cause instanceof IdentityProviderUnavailableError) {
    log.error(
      `WorkOS was ${cause.reason} during ${call}; vault-reset re-authentication is unavailable`,
      { reason: cause.reason },
    );
    return cause.reason === 'rate-limited'
      ? errors.rateLimited()
      : errors.unavailable(`workos ${cause.reason}`);
  }
  if (cause instanceof AuthenticationStepRequired) {
    log.warn(`WorkOS answered ${call} with a step this page does not take`, { step: cause.code });
    return errors.forbidden(STEP_MESSAGES[cause.code]);
  }
  if (cause instanceof IdentityVerificationError) {
    log.warn(`WorkOS refused ${call}`, { reason: cause.reason });
    return errors.forbidden(
      'That code is not right, or it has expired. Check the email, or send a new code.',
    );
  }
  return cause;
}
