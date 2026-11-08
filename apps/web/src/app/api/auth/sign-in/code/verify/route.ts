import { parseJsonBody } from '@/server/http';
import {
  checkCredential,
  codeKey,
  finishInAppSignIn,
  guardInAppSignIn,
  guessAttemptKey,
  inAppSignInFailure,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { codeSignInSchema } from '@/server/schemas/sign-in';
import { throttlePoolFor } from '@/server/sign-in-throttle';
import { workosProvider } from '@/server/workos';

/**
 * Signs in with the six-digit code `POST /api/auth/sign-in/code` had WorkOS
 * email — for an account that exists, and for the one WorkOS made for a new
 * address, which the linker then turns into a new xecret account with its own
 * personal organisation (`auth.signup`). A code from the inbox proves control
 * of the address, so the account it signs in to has a verified address; the
 * gate in `prepareSignIn` still checks that WorkOS says so.
 *
 * **No page links here.** The sign-in page's "email me a code" was removed —
 * "Forgot password?" covers a forgotten password — and the sign-up page posts
 * its code to `POST /api/auth/sign-up`, which checks it exactly as this does
 * and sets the chosen password. This route is kept as it was reviewed and
 * tested: support's way to sign somebody in by their inbox alone, and the
 * smallest change to bring the option back.
 *
 * Guessing is bounded before WorkOS is asked: the address bucket, this address
 * from this IP, this address from anywhere, and the durable per-address
 * lockout (`server/sign-in-throttle.ts`) — a six-digit code is worth bounding
 * however many addresses and data centres the guesses come from. WorkOS's own
 * limits sit behind those, and its codes last ten minutes.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'sign-in');
    const body = await parseJsonBody(request, codeSignInSchema);
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

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code');
  }
});
