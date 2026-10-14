import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { retainedRecoveryWrap } from '@/server/retained-vault-service';
import { authenticatedRoute } from '@/server/route';
import { retainedRecoveryWrapSchema } from '@/server/schemas/retained-vaults';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * The retained wrap one recovery code opens, found by the code's lookup hash.
 *
 * Every miss is the same answer and is counted against the retained vault's own
 * lockout before it is given. Not audited: resolving a hash proves only that a
 * code existed; `vault.recovered` is written when the restore proves the User
 * Key was opened.
 */
export const POST = authenticatedRoute<{ retainedId: string }>(
  async ({ request, params, principal, services }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_retained', user.user.id]));

    const body = await parseJsonBody(request, retainedRecoveryWrapSchema);
    return json({
      wrap: await retainedRecoveryWrap(services, user, params.retainedId, body.lookupHash),
    });
  },
);
