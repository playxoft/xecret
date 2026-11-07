import { parseJsonBody } from '@/server/http';
import {
  checkCredential,
  codeKey,
  endedPausedSignIn,
  finishInAppSignIn,
  guardInAppSignIn,
  guessAttemptKey,
  inAppSignInFailure,
  pausedSignInFor,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { emailVerificationSchema } from '@/server/schemas/sign-in';
import { SignInRefusal } from '@/server/sign-in';
import { signInSubject } from '@/server/sign-in-throttle';
import { workosProvider } from '@/server/workos';

/**
 * Finishes a password sign-in that WorkOS paused because the address was not
 * verified: the code WorkOS emailed to it, finished with the pending token the
 * password route sealed — beside that address — into this browser's
 * `HttpOnly`, `SameSite=Strict` verification cookie. One WorkOS call verifies
 * the address and authenticates; only then does the sign-in reach
 * `prepareSignIn`, whose verified-address gate it now passes — so an address
 * nobody has proven control of never gets a session, however the password was
 * obtained.
 *
 * Reachable only while the verification step is enabled
 * (`EMAIL_VERIFICATION_STEP` in `server/in-app-sign-in.ts`): with it off, no
 * cookie is ever minted, and every request here ends as an expired attempt.
 *
 * ── What it refuses before WorkOS is asked ──
 *  - Anything without the cookie, with an altered or expired one, or naming an
 *    address other than the one sealed in it: the attempt is over, and the
 *    cookie is cleared. The token never travels anywhere a page or another
 *    site could choose.
 *  - Guesses, by this route's own address bucket, the address from this IP,
 *    the address's code-guess bucket (the same one an emailed sign-in code
 *    spends), and the durable per-address lockout.
 *
 * The flow is dated from the paused password step, not from this request
 * (`finishInAppSignIn`'s `issuedAt`).
 */
export const POST = publicRoute(async ({ request, services }) => {
  // Cleared on every answer that ends the paused sign-in — a success, or a
  // cookie that can never finish — and kept for a wrong code, so the person
  // can try the right one.
  let clear: string[] = [];
  try {
    await guardInAppSignIn(services, request, 'verify-email');
    const body = await parseJsonBody(request, emailVerificationSchema);

    let paused;
    try {
      paused = await pausedSignInFor(services.env, request, body.email);
    } catch (cause) {
      if (cause instanceof SignInRefusal) clear = [endedPausedSignIn()];
      throw cause;
    }

    await spend(services, guessAttemptKey(services, body.email), 'per-address-and-email limit');
    await spend(services, codeKey('guess', body.email), 'per-email code-guess limit');

    const provider = workosProvider(services.env, { interactive: true });
    const exchange = await checkCredential(services, await signInSubject(paused.email), () =>
      provider.completeEmailVerification(
        { code: body.code, pendingAuthenticationToken: paused.pendingToken },
        requestContext(services),
      ),
    );

    clear = [endedPausedSignIn()];
    return await finishInAppSignIn(services, request, {
      exchange,
      provider,
      next: body.next,
      issuedAt: paused.issuedAt,
      extraCookies: clear,
    });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'code', clear);
  }
});
