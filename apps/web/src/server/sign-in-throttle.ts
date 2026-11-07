import { toBase64Url, utf8Encode } from '@xecret/core/crypto';
import {
  clearSignInFailures,
  findSignInFailures,
  recordSignInFailure,
} from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { SignInRefusal } from './sign-in';

/**
 * The durable brake on guessing a password or an emailed code on the in-app
 * sign-in page: consecutive failures per address, in the database
 * (`sign_in_failures`, migration 0034), checked before WorkOS is asked and
 * cleared by a success.
 *
 * ── Why, beside `RL_LOGIN` ──
 * The rate-limit binding is per data centre, keyed on what the request
 * carries, and fails open: somebody rotating addresses across colos meets a
 * fresh allowance at every hop. WorkOS's own per-address limit is WorkOS's to
 * change. This counter is global and ours, and it does not care where the
 * guesses come from — only how many have failed against this address.
 *
 * ── The policy ──
 * {@link SIGN_IN_FREE_FAILURES} consecutive failures cost nothing. Each one
 * after that locks the address for {@link SIGN_IN_LOCKOUT_BASE_MS}, doubling,
 * up to {@link SIGN_IN_LOCKOUT_MAX_MS}. The count survives a lockout expiring —
 * a guesser who waits out each delay keeps paying the ceiling rather than being
 * handed five free guesses again — and restarts only after
 * {@link SIGN_IN_FAILURE_WINDOW_MS} without a failure, or at the next success.
 *
 * ── The budget, worked ──
 * Free: 5. Then the delays before guesses 7, 8, … are 30 s, 1, 2, 4, 8 min and
 * 15 min from then on (guess 6 earns the first 30 s).
 *  - First hour: 5 free + guess 6 at 0 + guesses 7–11 after 30 s + 1 + 2 + 4 +
 *    8 min (15.5 min in all) + one every 15 min for the remaining ~44 min (2) —
 *    about **13 guesses**.
 *  - Every hour after: **4** (one per 15 min). A day: about **100**.
 *  - Against an emailed code (six digits, 10^6, alive for ten minutes): at most
 *    ~10 guesses land inside one code's life — 5 free, then 30 s + 1 + 2 + 4
 *    min of delays — a ~1-in-100,000 chance per code issued, and each new code
 *    is itself rate limited per address (`RL_LOGIN`).
 *  - Against a password: ~100 a day per address, from any number of
 *    addresses. That strangles guessing at one account. It does nothing
 *    against credential stuffing — one leaked password tried once per account
 *    across many accounts — which is what WorkOS Radar is for (a follow-up,
 *    and a precondition for general availability).
 *  - The owner who mistypes: five tries free, a 30-second pause on the sixth,
 *    a minute on the seventh. Nobody is locked out by a few typos, and a
 *    success wipes the slate.
 *
 * ── What it costs the real owner ──
 * The lockout is per address, so somebody else's wrong guesses lock the owner
 * out of *password and code* sign-in too — for at most 15 minutes after the
 * latest one, and only while somebody keeps paying a request (through every
 * other limit) for each 15 minutes of it. "Continue with Google" and single
 * sign-on do not pass through this, so they stay open throughout. That is the
 * trade every per-account lockout makes; the ceiling is what keeps it small.
 *
 * ── What counts ──
 * A credential WorkOS refused — a wrong password, an address with no account,
 * a wrong or expired code — and the answers the routes deliberately make look
 * the same (`in-app-sign-in.ts`). Not a request refused in front of WorkOS
 * (origin, shape, rate limit), not WorkOS being unavailable, and not a refusal
 * after WorkOS accepted the credential (an address conflict, an organisation's
 * single sign-on): those are not guesses.
 */

/** Consecutive failures that cost nothing. */
export const SIGN_IN_FREE_FAILURES = 5;

/** The first lockout, doubling with each failure after it. */
export const SIGN_IN_LOCKOUT_BASE_MS = 30 * 1000;

/** The ceiling on that doubling. */
export const SIGN_IN_LOCKOUT_MAX_MS = 15 * 60 * 1000;

/** A failure older than this no longer adds to the count: the next one starts it again. */
export const SIGN_IN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long the `failedAttempts`-th consecutive failure locks the address for, or `null`. */
export function signInLockoutFor(failedAttempts: number, now: Date): Date | null {
  if (failedAttempts <= SIGN_IN_FREE_FAILURES) return null;
  const step = failedAttempts - SIGN_IN_FREE_FAILURES - 1;
  // `step` grows without bound for a determined guesser; `2 ** 40` is still a
  // finite number, and `min` keeps the result at the ceiling.
  const delay = Math.min(SIGN_IN_LOCKOUT_BASE_MS * 2 ** Math.min(step, 40), SIGN_IN_LOCKOUT_MAX_MS);
  return new Date(now.getTime() + delay);
}

/** The SHA-256 of the lower-cased address: the counter's key, never the address. */
export async function signInSubject(email: string): Promise<Uint8Array<ArrayBuffer>> {
  const folded = email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(folded)));
}

/**
 * Refuses, as rate-limited, an address whose lockout is still running. Before
 * WorkOS is asked: a locked address costs nobody a call.
 */
export async function assertNotLockedOut(
  services: ServiceContext,
  subject: Uint8Array<ArrayBuffer>,
  now: Date = new Date(),
): Promise<void> {
  const state = await findSignInFailures(services.db, subject);
  if (state?.lockedUntil != null && state.lockedUntil > now) {
    throw new SignInRefusal(
      'rate-limited',
      429,
      `address locked after ${state.failedAttempts} consecutive failed sign-ins`,
    );
  }
}

/**
 * Counts one failed attempt against an address. Never allowed to fail the
 * answer the person is about to get: a counter that could not be written is
 * logged, and the attempt is still refused as the failure it was.
 */
export async function countSignInFailure(
  services: ServiceContext,
  subject: Uint8Array<ArrayBuffer>,
  now: Date = new Date(),
): Promise<void> {
  try {
    const state = await recordSignInFailure(services.db, {
      subjectHash: subject,
      now,
      windowStart: new Date(now.getTime() - SIGN_IN_FAILURE_WINDOW_MS),
      lockoutFor: signInLockoutFor,
    });
    if (state.lockedUntil !== null && state.lockedUntil > now) {
      services.log.at('signIn').warn('An address is locked after consecutive failed sign-ins', {
        failedAttempts: state.failedAttempts,
        lockedForSeconds: Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000),
        // A prefix of the hash, to tie a burst together in the log without
        // writing down the address.
        subject: toBase64Url(subject).slice(0, 12),
      });
    }
  } catch (cause) {
    services.log.at('signIn').error('Could not count a failed sign-in against its address', {
      error: cause instanceof Error ? cause.name : 'unknown',
    });
  }
}

/** A success: the address starts again with every free attempt. Best effort, like the count. */
export async function clearSignInFailuresFor(
  services: ServiceContext,
  subject: Uint8Array<ArrayBuffer>,
): Promise<void> {
  try {
    await clearSignInFailures(services.db, subject);
  } catch (cause) {
    services.log.at('signIn').error('Could not clear an address’s failed sign-ins', {
      error: cause instanceof Error ? cause.name : 'unknown',
    });
  }
}
