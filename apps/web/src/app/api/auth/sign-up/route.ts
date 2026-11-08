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
  weakPasswordAnswer,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { signUpSchema } from '@/server/schemas/sign-in';
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
 *  2. **Then the password** is set on the WorkOS user the code proved
 *     (`WorkosIdentityProvider.setPassword`).
 *  3. The shared tail (`finishInAppSignIn`): the linker makes the xecret
 *     account and its personal organisation for a new address, or signs an
 *     existing one in — the session, and the known-device cookie with it.
 *
 * ── Why the code comes first, and no `createUser` ──
 * The obvious order — create the WorkOS user with the password, then verify
 * the address — has two faults this order does not.
 *
 *  - **A pre-account takeover.** `createUser` with a password succeeds for an
 *    address nobody has proven. Whoever typed somebody else's address now holds
 *    a WorkOS user for it with a password of their choosing; when the real
 *    owner later proves the inbox some other way — Google, which WorkOS links
 *    by address, or an emailed code — that password is still there, and opens
 *    the owner's account. PR #100's note 12 rules exactly this out for the
 *    Firebase import. Here no password is set until the inbox is proven, by the
 *    request that sets it; and an existing user's password (an attacker's
 *    planted one included) is replaced by the owner's.
 *  - **An oracle.** `createUser` refuses an address that has a user —
 *    `user_creation_error` / `email_not_available` — and an answer for that
 *    case that looked like the new-address case would need a fabricated
 *    verification step that a stranger could not tell from a real one. With
 *    the code first, every address takes the same two calls — a code is mailed,
 *    and a code is checked — and nothing differs until the inbox is proven. A
 *    weak password can only be reported after that, too: WorkOS's policy is
 *    asked by the call that sets it.
 *
 * ── An address that already has an account ──
 * Is signed in to it, by the code, and its password becomes the one chosen
 * here — the same thing a reset would do, on the same proof (the inbox). The
 * page says so, in a sentence it shows for every address.
 *
 * ── A password WorkOS refuses ──
 * The page holds WorkOS's floor (ten characters) on the server and estimates
 * its zxcvbn bar before posting, so this is rare. When it happens the code has
 * been spent and the address is now verified, but nothing is signed in: the
 * answer is the sentence beside the password field, and the page goes back to
 * the form for a stronger one and a fresh code.
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

    // Only for an authentication the rest of the sign-in could accept: an
    // impersonated one, or one WorkOS does not call verified, is refused by
    // `prepareSignIn` next, and sets nothing on its way there.
    if (exchange.impersonator === null && exchange.identity.emailVerified) {
      try {
        await provider.setPassword(exchange.identity.subject, body.password);
      } catch (cause) {
        if (isWeakPassword(cause)) return weakPasswordAnswer(services);
        throw cause;
      }
    }

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code');
  }
});
