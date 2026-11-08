import { IdentityVerificationError } from '@xecret/core/auth';
import { noContent, parseJsonBody } from '@/server/http';
import {
  codeKey,
  guardInAppSignIn,
  holdMailAnswer,
  inAppSignInFailure,
  isFoldedAddressRefusal,
  requestContext,
  spend,
} from '@/server/in-app-sign-in';
import { publicRoute } from '@/server/route';
import { codeRequestSchema } from '@/server/schemas/sign-in';
import { assertPoolOpen, throttlePoolFor } from '@/server/sign-in-throttle';
import { workosProvider } from '@/server/workos';

/**
 * Has WorkOS email a six-digit code (Magic Auth) to an address — the sign-up
 * page's first step, whose code `POST /api/auth/sign-up` then takes with the
 * chosen password. The sign-in page no longer links here: its "email me a
 * code" became "Forgot password?". WorkOS sends the email itself; the copy of
 * the code in its answer is dropped unread by
 * `WorkosIdentityProvider.createMagicAuth`.
 *
 * ── The same answer for every address ──
 * A 204 whether or not the address has an account — WorkOS creates the WorkOS
 * user for an address it has not seen, which is what makes this the sign-up
 * path — and also when WorkOS declines the address: a refusal that names
 * a reason, a 403 among them, and `organization_authentication_methods_required`
 * (which would say the address is in an organisation with a policy). Saying
 * anything else would make this route an oracle for which addresses have
 * accounts. What it does say is the deployment's own trouble (unavailable,
 * rate-limited) and a WorkOS domain policy that this address's domain signs in
 * only by single sign-on: that is about a domain, not an account, and a code
 * that never arrives would be a worse answer. Every 204 waits out the same
 * floor (`holdMailAnswer`), so how long it took says no more than what it said.
 *
 * Mail goes to somebody's inbox, so the per-subject bucket is the address
 * alone — not the IP, which would hand a sender a fresh allowance per proxy
 * (`attemptKey`'s note) — and it is the one key every mail spends, a reset
 * link included; beside it, this route's own address bucket.
 *
 * Asking for a code is not a guess, so it spends nothing of the durable
 * throttle. But while the pool the code would be checked against is locked —
 * this browser's own, if it is known to the address, otherwise the address's
 * shared pool — it answers rate-limited instead of mailing a code nobody can
 * redeem until the lockout ends. That says nothing new about the address: a
 * pool locks the same way for an address with no account, and only somebody's
 * failed guesses lock it.
 */
export const POST = publicRoute(async ({ request, services }) => {
  try {
    await guardInAppSignIn(services, request, 'code-send');
    const body = await parseJsonBody(request, codeRequestSchema);
    await spend(services, codeKey('send', body.email), 'per-email code limit');
    // No code while the pool it would be checked against is locked: it could
    // not be redeemed, and mailing it anyway only fills somebody's inbox.
    await assertPoolOpen(services, await throttlePoolFor(services, request, body.email));

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
        await holdMailAnswer(services);
        return noContent();
      }
      throw cause;
    }

    services.bindLog({ signInOutcome: 'code-sent' });
    await holdMailAnswer(services);
    return noContent();
  } catch (cause) {
    return inAppSignInFailure(services, cause, null);
  }
});
