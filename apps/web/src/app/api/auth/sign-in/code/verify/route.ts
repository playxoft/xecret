import { parseJsonBody } from '@/server/http';
import {
  codeKey,
  finishInAppSignIn,
  guardInAppSignIn,
  inAppSignInFailure,
  passwordAttemptKey,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { codeSignInSchema } from '@/server/schemas/sign-in';
import { workosProvider } from '@/server/workos';

/**
 * Signs in with the six-digit code `POST /api/auth/sign-in/code` had WorkOS
 * email — for an account that exists, and for the one WorkOS made for a new
 * address, which the linker then turns into a new xecret account with its own
 * personal organisation (`auth.signup`). A code from the inbox proves control
 * of the address, so the account it signs in to has a verified address; the
 * gate in `prepareSignIn` still checks that WorkOS says so.
 *
 * Guessing is bounded before WorkOS is asked: the address bucket, this address
 * from this IP, and this address from anywhere — a six-digit code is worth
 * bounding however many addresses the guesses come from. WorkOS's own limits
 * sit behind those, and its codes last ten minutes.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request);
    const body = await parseJsonBody(request, codeSignInSchema);
    await spend(services, passwordAttemptKey(services, body.email), 'per-address-and-email limit');
    await spend(services, codeKey('guess', body.email), 'per-email code-guess limit');

    const provider = workosProvider(services.env);
    const exchange = await provider.signInWithMagicAuth(
      { email: body.email, code: body.code },
      requestContext(services),
    );

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code');
  }
});
