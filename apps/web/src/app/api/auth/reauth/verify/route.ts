import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { verifyReauth } from '@/server/reauth-service';
import { authenticatedRoute } from '@/server/route';
import { reauthVerifySchema } from '@/server/schemas/vault';
import { primaryOrgId, requireUserPrincipal } from '@/server/vault-service';

/**
 * Checks the emailed code and hands back the vault reset's proof: a one-time,
 * five-minute token bound to this session and this user. See
 * `server/reauth-service.ts`.
 *
 * Guessing is bounded twice: here, by the rate limiter on the account, and in
 * the attempt's own row, which ends after five wrong codes whether or not a
 * rate limiter is configured.
 *
 * The response carries the proof and nothing else worth stealing; it is
 * `no-store` like every API response, and the client spends it in the very
 * next request.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['reauth_verify', user.user.id]));

    const { code } = await parseJsonBody(request, reauthVerifySchema);
    const { proof, expiresAt } = await verifyReauth(services, user, code);

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

    return json({ reauthProof: proof, expiresAt: expiresAt.toISOString() });
  },
  { allowLocked: true },
);
