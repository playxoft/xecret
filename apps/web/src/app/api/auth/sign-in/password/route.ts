import { json, parseJsonBody } from '@/server/http';
import {
  finishInAppSignIn,
  guardInAppSignIn,
  inAppSignInFailure,
  passwordAttemptKey,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { passwordSignInSchema } from '@/server/schemas/sign-in';
import { AuthenticationStepRequired, workosProvider } from '@/server/workos';

/**
 * Signs in with an email and a password typed on xecret's own sign-in page —
 * accounts migrated from Firebase brought theirs. See `server/in-app-sign-in.ts`
 * for the guards in front of WorkOS, the shared tail behind it and how it
 * answers.
 *
 * One answer of its own: an address WorkOS has not verified comes back as
 * `email_verification_required`, and WorkOS emails that address a code. The
 * page is handed WorkOS's pending token and asks for the code, which
 * `POST /api/auth/sign-in/verify-email` finishes with — no session exists until
 * then, so the verified-address gate in `prepareSignIn` holds. The token is
 * worthless without the code in that inbox.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request);
    const body = await parseJsonBody(request, passwordSignInSchema);
    await spend(services, passwordAttemptKey(services, body.email), 'per-address-and-email limit');

    const provider = workosProvider(services.env);
    let exchange;
    try {
      exchange = await provider.signInWithPassword(
        { email: body.email, password: body.password },
        requestContext(services),
      );
    } catch (cause) {
      if (
        cause instanceof AuthenticationStepRequired &&
        cause.code === 'email_verification_required' &&
        cause.pendingAuthenticationToken !== null
      ) {
        services.bindLog({
          signInOutcome: 'email-verification-required',
          signInPurpose: 'sign-in',
        });
        return json({ step: 'verify-email', pendingToken: cause.pendingAuthenticationToken });
      }
      throw cause;
    }

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'password');
  }
});
