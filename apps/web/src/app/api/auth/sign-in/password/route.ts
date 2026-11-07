import { json, parseJsonBody } from '@/server/http';
import {
  checkCredential,
  emailVerificationStepEnabled,
  finishInAppSignIn,
  guardInAppSignIn,
  guessAttemptKey,
  inAppSignInFailure,
  passwordFoldedSteps,
  pausedSignInCookie,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { passwordSignInSchema } from '@/server/schemas/sign-in';
import { signInSubject } from '@/server/sign-in-throttle';
import { AuthenticationStepRequired, workosProvider } from '@/server/workos';

/**
 * Signs in with an email and a password typed on xecret's own sign-in page —
 * accounts migrated from Firebase brought theirs. See `server/in-app-sign-in.ts`
 * for the guards in front of WorkOS, the shared tail behind it and how it
 * answers.
 *
 * ── An address WorkOS has not verified ──
 * WorkOS answers `email_verification_required`, and emails the address a code.
 * By default that answer is the wrong-password answer, counted like one —
 * because it cannot yet be shown that WorkOS checks the password before it
 * decides, and if it does not, anything else would be an oracle for unverified
 * accounts (`EMAIL_VERIFICATION_STEP` in `server/in-app-sign-in.ts`). The
 * person's way in is "email me a code", which verifies the address as it signs
 * them in.
 *
 * With the step enabled, the page is told `{ step: 'verify-email' }` and asks
 * for the code; WorkOS's pending token is sealed beside the address into an
 * `HttpOnly`, `SameSite=Strict` cookie — the page never holds it — which
 * `POST /api/auth/sign-in/verify-email` finishes with. No session exists until
 * then, so the verified-address gate in `prepareSignIn` holds either way.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'sign-in');
    const body = await parseJsonBody(request, passwordSignInSchema);
    await spend(services, guessAttemptKey(services, body.email), 'per-address-and-email limit');

    const provider = workosProvider(services.env, { interactive: true });
    const subject = await signInSubject(body.email);
    const startedAt = Math.floor(Date.now() / 1000);
    let exchange;
    try {
      exchange = await checkCredential(
        services,
        subject,
        () =>
          provider.signInWithPassword(
            { email: body.email, password: body.password },
            requestContext(services),
          ),
        passwordFoldedSteps(),
      );
    } catch (cause) {
      if (
        emailVerificationStepEnabled() &&
        cause instanceof AuthenticationStepRequired &&
        cause.code === 'email_verification_required' &&
        cause.pendingAuthenticationToken !== null
      ) {
        services.bindLog({
          signInOutcome: 'email-verification-required',
          signInPurpose: 'sign-in',
        });
        return json(
          { step: 'verify-email' },
          {
            cookies: [
              await pausedSignInCookie(services.env, {
                email: body.email,
                pendingToken: cause.pendingAuthenticationToken,
                issuedAt: startedAt,
              }),
            ],
          },
        );
      }
      throw cause;
    }

    return await finishInAppSignIn(services, request, { exchange, provider, next: body.next });
  } catch (cause) {
    return inAppSignInFailure(services, cause, 'password');
  }
});
