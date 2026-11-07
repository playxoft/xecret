import { parseJsonBody } from '@/server/http';
import {
  finishInAppSignIn,
  guardInAppSignIn,
  inAppSignInFailure,
  requestContext,
  spend,
  verificationKey,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { emailVerificationSchema } from '@/server/schemas/sign-in';
import { workosProvider } from '@/server/workos';

/**
 * Finishes a password sign-in that WorkOS paused because the address was not
 * verified: the code WorkOS emailed to it, and the pending token the password
 * route handed the page. One WorkOS call verifies the address and
 * authenticates; only then does the sign-in reach `prepareSignIn`, whose
 * verified-address gate it now passes — so an address nobody has proven
 * control of never gets a session, however the password was obtained.
 *
 * Guesses at the code are bounded per pending token (one paused
 * authentication of one user) as well as per address, before WorkOS is asked.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request);
    const body = await parseJsonBody(request, emailVerificationSchema);
    await spend(services, await verificationKey(body.pendingToken), 'per-token verification limit');

    const provider = workosProvider(services.env);
    const exchange = await provider.completeEmailVerification(
      { code: body.code, pendingAuthenticationToken: body.pendingToken },
      requestContext(services),
    );

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code');
  }
});
