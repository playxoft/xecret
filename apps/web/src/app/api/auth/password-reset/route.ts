import { noContent, parseJsonBody } from '@/server/http';
import {
  codeKey,
  guardInAppSignIn,
  holdMailAnswer,
  inAppSignInFailure,
  spend,
} from '@/server/in-app-sign-in';
import { foldedResetReason, isFoldedResetRefusal } from '@/server/password-reset';
import { publicRoute } from '@/server/route';
import { passwordResetRequestSchema } from '@/server/schemas/sign-in';
import { workosProvider } from '@/server/workos';

/**
 * "Forgot password?" — has WorkOS email a link to reset the password of the
 * account at an address (`server/password-reset.ts` has the flow).
 *
 * ── The same answer for every address ──
 * A 204, with nothing in it, whether or not the address has an account, and
 * whatever WorkOS said about the address (`isFoldedResetRefusal`) — after the
 * same floor, so the time it takes says no more than the answer. The page then
 * says the one sentence true of every address: if it has an account, an email
 * is on its way. What it does say is the deployment's own trouble — WorkOS
 * unreachable, or refusing our key — which is the same for every address.
 *
 * ── Brakes ──
 * In front of WorkOS, in order: same origin and JSON, failing closed (the
 * login-CSRF guard every in-app route has — here it keeps another site from
 * mailing somebody resets from their own browser); this route's own address
 * bucket (`password_reset_ip:<ip>`); the body; and the per-address mail bucket
 * — the one key every mail to an inbox spends, a sign-up code included, so
 * alternating between them buys nothing.
 *
 * Deliberately **not** held back by the durable sign-in lockout, unlike a
 * code request: the reset is how the owner gets in while somebody else keeps
 * their address's shared pool locked, and the link's own use is not counted
 * there either (the header of `server/password-reset.ts`).
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'password-reset');
    const body = await parseJsonBody(request, passwordResetRequestSchema);
    await spend(services, codeKey('send', body.email), 'per-email mail limit');

    try {
      await workosProvider(services.env, { interactive: true }).sendPasswordReset(body.email);
      services.bindLog({ signInOutcome: 'reset-sent' });
    } catch (cause) {
      if (!isFoldedResetRefusal(cause)) throw cause;
      services.log
        .at('passwordReset')
        .warn('WorkOS sent no reset link; the page was answered as if it had sent one', {
          reason: foldedResetReason(cause),
        });
      services.bindLog({ signInOutcome: 'reset-refused' });
    }

    await holdMailAnswer(services);
    return noContent();
  } catch (cause) {
    return inAppSignInFailure(services, cause, null);
  }
});
