import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { verifyReauth } from '@/server/reauth-service';
import { authenticatedRoute } from '@/server/route';
import { reauthVerifySchema } from '@/server/schemas/vault';
import { primaryOrgId, requireUserPrincipal } from '@/server/vault-service';

/**
 * Checks a guess at lock two — `{ code }` from the email, or `{ totp, mfaToken }`
 * when WorkOS asked for the user's authenticator after a right code — and hands
 * back either the vault reset's proof (a one-time, five-minute token bound to
 * this session and this user) or `{ mfaRequired, mfaToken }`. See
 * `server/reauth-service.ts`.
 *
 * Guessing is bounded three times: by the rate limiter on the account; by the
 * attempt's own row (five guesses, reserved before WorkOS is asked); and by the
 * account's daily total across every attempt (ten). The last two are columns,
 * so they hold whether or not a rate limiter is configured.
 *
 * The response carries the proof and nothing else worth stealing; it is
 * `no-store` like every API response, and the client spends it in the very
 * next request.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['reauth_verify', user.user.id]));

    const guess = await parseJsonBody(request, reauthVerifySchema);
    const result = await verifyReauth(services, user, guess);

    // The emailed code was right and WorkOS wants the authenticator too. The
    // pending token goes to the browser, which sends it back with the TOTP
    // code; this server keeps only its hash, on this attempt.
    if (result.kind === 'mfa') return json({ mfaRequired: true, mfaToken: result.mfaToken });

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          'auth.reauthenticated',
          { type: 'session', id: user.sessionId },
          { source: 'dashboard', reason: 'vault reset' },
        ),
      );
    }

    return json({ reauthProof: result.proof, expiresAt: result.expiresAt.toISOString() });
  },
  { allowLocked: true },
);
