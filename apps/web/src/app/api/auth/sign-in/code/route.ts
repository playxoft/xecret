import { IdentityVerificationError } from '@xecret/core/auth';
import { noContent, parseJsonBody } from '@/server/http';
import {
  codeKey,
  guardInAppSignIn,
  inAppSignInFailure,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { codeRequestSchema } from '@/server/schemas/sign-in';
import { AuthenticationStepRequired, workosProvider } from '@/server/workos';

/**
 * Has WorkOS email a six-digit sign-in code (Magic Auth) to an address — the
 * sign-in page's "email me a code" and the sign-up page's only form. WorkOS
 * sends the email itself; the copy of the code in its answer is dropped unread
 * by `WorkosIdentityProvider.createMagicAuth`.
 *
 * ── The same answer for every address ──
 * A 204 whether or not the address has an account — WorkOS creates the WorkOS
 * user for an address it has not seen, which is what makes this the sign-up
 * path too — and also when WorkOS refuses the request for a reason about the
 * address. Saying anything else would make this route an oracle for which
 * addresses have accounts. What it does say is the deployment's own trouble
 * (unavailable, rate-limited) and a WorkOS domain policy that this address's
 * organisation signs in only by single sign-on: that is about a domain, not an
 * account, and a code that never arrives would be a worse answer.
 *
 * Mail goes to somebody's inbox, so the per-subject bucket is the address
 * alone — not the IP, which would hand a sender a fresh allowance per proxy
 * (`attemptKey`'s note) — beside the address bucket every sign-in route spends.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request);
    const body = await parseJsonBody(request, codeRequestSchema);
    await spend(services, codeKey('send', body.email), 'per-email code limit');

    try {
      await workosProvider(services.env).createMagicAuth(body.email, requestContext(services));
    } catch (cause) {
      if (
        cause instanceof IdentityVerificationError &&
        !(cause instanceof AuthenticationStepRequired)
      ) {
        services.log
          .at('signIn')
          .warn(
            'WorkOS refused to email a sign-in code; the page was answered as if it had sent one',
            { reason: cause.reason },
          );
        services.bindLog({ signInOutcome: 'code-refused' });
        return noContent();
      }
      throw cause;
    }

    services.bindLog({ signInOutcome: 'code-sent' });
    return noContent();
  } catch (cause) {
    return inAppSignInFailure(services, cause, null);
  }
});
