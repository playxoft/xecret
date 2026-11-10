import { IdentityVerificationError } from '@xecret/core/auth';
import { ApiError } from '@/server/errors';
import { json, noContent, parseJsonBody } from '@/server/http';
import {
  guardInAppSignIn,
  inAppSignInFailure,
  isWeakPassword,
  weakPasswordAnswer,
} from '@/server/in-app-sign-in';
import type { ServiceContext } from '@/server/context';
import { afterPasswordReset } from '@/server/password-reset';
import { publicRoute } from '@/server/route';
import { passwordResetSchema } from '@/server/schemas/sign-in';
import { SIGN_IN_FORM_MESSAGES } from '@/lib/sign-in-errors';
import { AuthenticationStepRequired, workosProvider } from '@/server/workos';

/**
 * Sets a new password from the emailed reset link: `{ token, password }`, the
 * token being the link's `?token=` (`/sign-in/reset-password` reads it and
 * drops it from the address bar). `server/password-reset.ts` has the flow.
 *
 * In front of WorkOS: same origin and JSON, failing closed; this route's own
 * address bucket (`password_reset_confirm_ip:<ip>`); the body, held to shape —
 * the token to a bounded, URL-safe string and the password to WorkOS's own
 * ten-character floor. Not counted in the durable lockout, for the reasons the
 * module header gives: the token names no address until WorkOS has accepted
 * it, and the reset is the owner's way in while their address is under attack.
 *
 * ── Its answers ──
 *  - **204** — the password is changed. Every xecret session of the account
 *    is ended and its address's shared lockout pool cleared
 *    (`afterPasswordReset`); no session is made here, and no known-device
 *    cookie: the person signs in with the new password, on the sign-in page.
 *  - **400, the link** — a token WorkOS never issued, or one past its fifteen
 *    minutes, or already used: one sentence for all of them, above the form.
 *  - **400, beside the password** — a good link, and a password WorkOS's
 *    policy refuses. The link still works for another try.
 *  - WorkOS unreachable, timed out or rate-limiting: the service's trouble,
 *    never "your link expired".
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'password-reset-confirm');
    const body = await parseJsonBody(request, passwordResetSchema);

    let reset: { workosUserId: string; email: string };
    try {
      reset = await workosProvider(services.env, { interactive: true }).resetPassword({
        token: body.token,
        newPassword: body.password,
      });
    } catch (cause) {
      if (isWeakPassword(cause)) return weakPasswordAnswer(services);
      if (
        cause instanceof IdentityVerificationError &&
        !(cause instanceof AuthenticationStepRequired)
      ) {
        return resetLinkRefused(services, cause.reason);
      }
      throw cause;
    }

    await afterPasswordReset(services, reset);
    services.bindLog({ signInOutcome: 'password-reset' });
    return noContent();
  } catch (cause) {
    return inAppSignInFailure(services, cause, null);
  }
});

/** A reset token WorkOS will not take, as the sentence above the form. */
function resetLinkRefused(services: ServiceContext, reason: string): Response {
  const message = SIGN_IN_FORM_MESSAGES['reset-link-invalid'];
  services.log
    .at('passwordReset')
    .warn('Refused a password reset: WorkOS did not accept the link', {
      reason,
      status: 400,
    });
  services.bindLog({ signInOutcome: 'refused', signInRefusal: 'reset-link-invalid' });
  return json(new ApiError('bad_request', message).toBody(services.meta.requestId), {
    status: 400,
  });
}
