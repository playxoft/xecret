import { IdentityVerificationError } from '@xecret/core/auth';
import {
  findUserByEmail,
  findUserByWorkosId,
  listOrganizationsForUser,
  revokeAllUserSessions,
} from '@xecret/db/repositories';
import type { User } from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { auditFor, writeEvents } from './sign-in';
import { addressPool, clearSignInPool } from './sign-in-throttle';
import { IdentityProviderUnavailableError } from './workos';

/**
 * "Forgot password?", on xecret's own pages — the server half.
 *
 * Two routes, both behind the in-app sign-in's guard (`server/in-app-sign-in.ts`:
 * same origin, JSON, the address bucket, in that order, before the body is read):
 *
 *  - `POST /api/auth/password-reset` — `{ email }`. Has WorkOS email a reset
 *    link (`WorkosIdentityProvider.sendPasswordReset`). Answers **204 for every
 *    address** — one with an account, one without (WorkOS's 404), one WorkOS
 *    declines, and one WorkOS rate-limits — after the same
 *    floor (`MAIL_ANSWER_FLOOR_MS`), so neither the answer nor its timing
 *    says which. Mail to an inbox: the per-address mail bucket the sign-up's
 *    code spends too.
 *  - `POST /api/auth/password-reset/confirm` — `{ token, password }`. The
 *    token is the link's `?token=`; WorkOS sets the password, verifies the
 *    address, and revokes its own sessions for the user.
 *
 * The link is the WorkOS environment's **password reset URL** — a dashboard
 * setting (Applications → the application → Redirects), which must be
 * `<origin>/sign-in/reset-password` in each environment; its default is
 * AuthKit's own page (`docs/operations/workos-environments.md` §5).
 *
 * ── After a reset: sign in, not signed in ──
 * WorkOS's answer is the user, not a session. One could be made — a password
 * sign-in with the password just set — but it would make the reset link a
 * login-CSRF primitive: an attacker requests a reset for *their own* account,
 * sends the link to a victim, and the victim, choosing "their" new password,
 * is signed in to the attacker's account and stores secrets in it. So the
 * page says the password was changed and sends the person to sign in, where
 * they type their own address.
 *
 * ── What a reset ends, and clears ──
 *  - Every xecret session of the account that WorkOS user is (the WorkOS
 *    ones WorkOS ends itself): a reset is how an account is taken back from
 *    whoever else is signed in to it. Audited as `auth.session_revoked`. The
 *    account is found by its WorkOS user — or, for one not yet linked to
 *    WorkOS (a Firebase-era account whose sessions predate the move, and last
 *    thirty days), by the address WorkOS reset, on the linker's own terms: an
 *    unlinked row holding exactly that address (`accountForReset`). The reset
 *    has just proven the inbox, which is the proof the linker adopts such an
 *    account on.
 *  - The address's shared throttle pool: the person has just proven the inbox
 *    and chosen a password, and the sign-in that follows must not wait out a
 *    lockout somebody else ran up. (Clearing it gives an attacker nothing:
 *    clearing takes the inbox.)
 * Both best effort, after WorkOS has already changed the password — a failure
 * is logged at `error`, and the person is still told the truth: their password
 * was changed.
 *
 * ── Why the completion is not counted in the durable throttle ──
 * Every other credential here is counted against the address's pool *before*
 * WorkOS is asked. A reset token cannot be: it is opaque, it names no address,
 * and WorkOS has no lookup by token, so the address is unknown until WorkOS
 * has already accepted it — and a refused token never names one at all.
 * Asking the person to type the address would pick a pool without binding
 * anything (an attacker types whichever address they like), and would hand
 * a griefer the recovery path: a shared pool held locked for fifteen minutes
 * at a time would outlast every fifteen-minute link, so the owner could never
 * reset from a new browser while being attacked. The brake on the token is
 * its own: about 150 bits of WorkOS's randomness, fifteen minutes, single use,
 * and this route's address bucket. The brake on the *request* — the part that
 * fills an inbox — is the mail bucket.
 *
 * ── A first password ──
 * A reset works for any WorkOS user, including one that has never had a
 * password (made by an emailed code, or by Google): it sets their first. That
 * is how a code-only account arms the vault reset's first lock (which counts a
 * password sign-in, not an emailed code).
 *
 * ── Never logged, never echoed ──
 * The token and the password are read from the body, handed to one WorkOS
 * call, and dropped. WorkOS's refusal of an unknown token quotes the token in
 * its message; nothing here reads a WorkOS message.
 */

/**
 * Whether WorkOS not sending a reset link is about the address — answered with
 * the same 204 as a link sent. That is every refusal WorkOS can give for one
 * address and not another: no user (404), an address it declines (a 4xx, a
 * named 403, a policy step), and its own per-address rate limit, which only
 * an address with a user might reach. WorkOS unreachable, or refusing this
 * deployment's key, is the same for every address, and is said.
 */
export function isFoldedResetRefusal(cause: unknown): boolean {
  return (
    cause instanceof IdentityVerificationError ||
    (cause instanceof IdentityProviderUnavailableError && cause.reason === 'rate-limited')
  );
}

/** The bounded, log-safe reason for a folded refusal — never WorkOS's message. */
export function foldedResetReason(cause: unknown): string {
  if (cause instanceof IdentityVerificationError) return cause.reason;
  return cause instanceof IdentityProviderUnavailableError ? cause.reason : 'refused';
}

/**
 * The xecret account a finished reset belongs to, or `null`.
 *
 *  1. The account linked to the WorkOS user WorkOS reset — the ordinary case.
 *  2. Otherwise, an account **not yet linked to WorkOS** that holds exactly the
 *     address WorkOS reset: a Firebase-era account whose owner has not signed
 *     in since the move. Its sessions are as live as anybody's (thirty days),
 *     and the reset has just proven the inbox — the proof the linker adopts
 *     such an account on (`upsertUserFromWorkosIdentity`, step 2). Held to the
 *     linker's terms exactly: the row must be unlinked, and its address the
 *     same mailbox under ASCII-only folding ({@link isSameMailbox}) — never a
 *     row bound to another WorkOS user, which is somebody else's account.
 */
export async function accountForReset(
  services: ServiceContext,
  reset: { workosUserId: string; email: string },
): Promise<User | null> {
  const linked = await findUserByWorkosId(services.db, reset.workosUserId);
  if (linked !== null) return linked;
  const holder = await findUserByEmail(services.db, reset.email);
  if (holder === null || holder.workosUserId !== null) return null;
  return isSameMailbox(holder.email, reset.email) ? holder : null;
}

/**
 * The linker's adoption rule for two addresses (`isSameAddress` in
 * `@xecret/db`'s users repository), restated: the presented address is
 * printable ASCII and the two agree under ASCII-only case folding. `email` is
 * citext, whose Unicode folding would call a Kelvin sign an ASCII `k`; an
 * address that only citext calls equal is not the mailbox the reset proved.
 */
export function isSameMailbox(stored: string, presented: string): boolean {
  const fold = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return /^[\x21-\x7e]+$/.test(presented) && fold(stored) === fold(presented);
}

/**
 * After WorkOS accepted a reset: the account's sessions ended, and the
 * address's shared pool cleared. Best effort; see the header.
 */
export async function afterPasswordReset(
  services: ServiceContext,
  reset: { workosUserId: string; email: string },
): Promise<void> {
  // The sessions first: they are the part that takes an account back.
  try {
    const user = await accountForReset(services, reset);
    // A WorkOS user with no xecret account yet — one made by a code that was
    // never entered — has no sessions to end.
    if (user !== null) {
      const revoked = await revokeAllUserSessions(services.db, user.id);
      services.log
        .at('passwordReset')
        .info('Ended every session of an account whose password was reset', {
          revokedSessions: revoked,
        });
      const memberships = await listOrganizationsForUser(services.db, user.id);
      const primary = memberships[0];
      if (primary !== undefined) {
        await writeEvents(services, [
          auditFor(primary.organization.id, user, services).success(
            'auth.session_revoked',
            { type: 'session', id: null },
            { reason: 'password-reset' },
          ),
        ]);
      }
    }
  } catch (cause) {
    services.log
      .at('passwordReset')
      .error(
        'A password was reset, but the account’s sessions could not be ended — they last ' +
          'until they expire or are signed out',
        { error: describeError(cause) },
      );
  }

  try {
    await clearSignInPool(services, {
      subject: await addressPool(services.env, reset.email),
      kind: 'address',
    });
  } catch (cause) {
    services.log
      .at('passwordReset')
      .error('A password was reset, but its address’s sign-in throttle pool could not be cleared', {
        error: describeError(cause),
      });
  }
}
