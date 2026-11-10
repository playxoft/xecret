import { parseJsonBody } from '@/server/http';
import {
  checkCredential,
  codeKey,
  finishInAppSignIn,
  guardInAppSignIn,
  guessAttemptKey,
  inAppSignInFailure,
  isWeakPassword,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { errorName } from '@/server/logging';
import { publicRoute } from '@/server/route';
import { signUpSchema } from '@/server/schemas/sign-in';
import type { CompletedSignIn } from '@/server/sign-in-completion';
import { throttlePoolFor } from '@/server/sign-in-throttle';
import { workosProvider } from '@/server/workos';

/**
 * Creating an account with an email and a password — the sign-up page's second
 * step. The first was `POST /api/auth/sign-in/code`: WorkOS emailed the address
 * a six-digit code (and made a WorkOS user for an address it had none for).
 * This takes that code with the password the person chose beside the address,
 * which the page held until now.
 *
 *  1. **The code**, exactly as `POST /api/auth/sign-in/code/verify` checks one:
 *     the address bucket, this address from this IP, the address's code-guess
 *     bucket, and the durable per-address lockout, counted first
 *     (`checkCredential`). A right code proves the inbox and authenticates.
 *  2. **The sign-in**, through the shared tail (`finishInAppSignIn`): the
 *     linker makes the xecret account and its personal organisation for a new
 *     address, or finds the existing one; the session, and the known-device
 *     cookie with it — or the confirmation, for a sign-in held back. Any
 *     refusal ends the request here, and nothing has been set.
 *  3. **Then, and only for an account this sign-up created**, the password
 *     (`WorkosIdentityProvider.setPassword`). "Created" is the linker's own
 *     outcome, decided in the same write that made the row — not a lookup
 *     made beforehand, which a concurrent sign-in could make stale.
 *
 * ── An address that already has an account ──
 * **Its credentials are never touched.** The code signs the person in to it —
 * the inbox is the proof every emailed code is — and the answer carries
 * `notice: 'existing-account'`: the page says they already had an account,
 * were signed in, and that "Forgot password?" is how a password is changed.
 * Changing it here would be a password reset with none of a reset's
 * consequences — no sessions ended, nothing audited, nothing said — handing
 * anybody with a moment's access to the inbox a lasting password (one that
 * also arms the vault reset's first lock) while the owner's sessions stayed
 * alive. The notice comes only after the code, so it tells nobody anything the
 * inbox did not.
 *
 * ── Why the code comes first, and no `createUser` ──
 *  - **A pre-account takeover.** `createUser` with a password succeeds for an
 *    address nobody has proven. Whoever typed somebody else's address would
 *    hold a WorkOS user for it with a password of their choosing, still there
 *    when the real owner later proved the inbox some other way — Google, which
 *    WorkOS links by address, or an emailed code. PR #100's note 12 rules
 *    exactly this out for the Firebase import. Here no password is set until
 *    the inbox is proven, by the request that sets it.
 *  - **An oracle.** `createUser` refuses an address that has a user —
 *    `user_creation_error` / `email_not_available`. With the code first, every
 *    address takes the same two calls — a code is mailed, a code is checked —
 *    and nothing differs until the inbox is proven.
 *
 * ── A password that cannot be set ──
 * The account exists and the person is signed in by then, so it is not a
 * refusal: the answer carries `notice: 'password-too-weak'` (WorkOS's policy;
 * the page holds WorkOS's floor and estimates its zxcvbn bar first, so this is
 * rare) or `notice: 'password-not-set'` (WorkOS failing), and the page says
 * the account is ready and "Forgot password?" sets one — which works for an
 * account that has never had a password. Nothing is lost: the account is
 * theirs alone, and has no password anybody else chose.
 *
 * The password is read from the body, handed to the one WorkOS call that sets
 * it, and dropped — never logged, echoed or stored.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'sign-in');
    const body = await parseJsonBody(request, signUpSchema);
    await spend(services, guessAttemptKey(services, body.email), 'per-address-and-email limit');
    await spend(services, codeKey('guess', body.email), 'per-email code-guess limit');

    const provider = workosProvider(services.env, { interactive: true });
    const exchange = await checkCredential(
      services,
      await throttlePoolFor(services, request, body.email),
      () =>
        provider.signInWithMagicAuth(
          { email: body.email, code: body.code },
          requestContext(services),
        ),
    );

    return await finishInAppSignIn(services, request, {
      exchange,
      provider,
      next: body.next,
      after: async (done: CompletedSignIn) => {
        const log = services.log.at('signUp');
        if (done.outcome !== 'created') {
          log.info(
            'A sign-up reached an account that already existed: signed in, nothing changed',
            {
              outcome: done.outcome,
            },
          );
          services.bindLog({ signUpOutcome: 'existing-account' });
          return { notice: 'existing-account' };
        }
        try {
          await provider.setPassword(exchange.identity.subject, body.password);
          services.bindLog({ signUpOutcome: 'created' });
          return {};
        } catch (cause) {
          // Never thrown on: the account and its session already exist.
          const weak = isWeakPassword(cause);
          const reason =
            typeof (cause as { reason?: unknown }).reason === 'string'
              ? (cause as { reason: string }).reason
              : errorName(cause);
          if (weak) {
            log.warn('A new account was made, but WorkOS refused its chosen password', { reason });
          } else {
            log.error('A new account was made, but its chosen password could not be set', {
              reason,
            });
          }
          services.bindLog({ signUpOutcome: 'created-without-password' });
          return { notice: weak ? 'password-too-weak' : 'password-not-set' };
        }
      },
    });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code');
  }
});
