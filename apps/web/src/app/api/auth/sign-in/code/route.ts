import { IdentityVerificationError } from '@xecret/core/auth';
import { noContent, parseJsonBody } from '@/server/http';
import {
  codeKey,
  guardInAppSignIn,
  inAppSignInFailure,
  isFoldedAddressRefusal,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { codeRequestSchema } from '@/server/schemas/sign-in';
import { workosProvider } from '@/server/workos';

/**
 * Has WorkOS email a six-digit sign-in code (Magic Auth) to an address — the
 * sign-in page's "email me a code" and the sign-up page's only form. WorkOS
 * sends the email itself; the copy of the code in its answer is dropped unread
 * by `WorkosIdentityProvider.createMagicAuth`.
 *
 * ── The same answer for every address ──
 * A 204 whether or not the address has an account — WorkOS creates the WorkOS
 * user for an address it has not seen, which is what makes this the sign-up
 * path too — and also when WorkOS declines the address: a refusal that names
 * a reason, a 403 among them, and `organization_authentication_methods_required`
 * (which would say the address is in an organisation with a policy). Saying
 * anything else would make this route an oracle for which addresses have
 * accounts. What it does say is the deployment's own trouble (unavailable,
 * rate-limited) and a WorkOS domain policy that this address's domain signs in
 * only by single sign-on: that is about a domain, not an account, and a code
 * that never arrives would be a worse answer.
 *
 * Mail goes to somebody's inbox, so the per-subject bucket is the address
 * alone — not the IP, which would hand a sender a fresh allowance per proxy
 * (`attemptKey`'s note) — beside this route's own address bucket. Asking for
 * a code is not a guess, so it neither checks nor spends the durable
 * per-address lockout; the code it sends is guarded where it is checked.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'code-send');
    const body = await parseJsonBody(request, codeRequestSchema);
    await spend(services, codeKey('send', body.email), 'per-email code limit');

    try {
      await workosProvider(services.env, { interactive: true }).createMagicAuth(
        body.email,
        requestContext(services),
      );
    } catch (cause) {
      if (isFoldedAddressRefusal(cause)) {
        services.log
          .at('signIn')
          .warn(
            'WorkOS refused to email a sign-in code; the page was answered as if it had sent one',
            { reason: cause instanceof IdentityVerificationError ? cause.reason : 'refused' },
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
