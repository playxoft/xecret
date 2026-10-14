import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { retainedMaterial } from '@/server/retained-vault-service';
import { authenticatedRoute } from '@/server/route';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * What the browser needs to open one retained vault: its passphrase wrap, salt
 * and parameters, its encrypted private key, and its grants with the
 * environments they open. Not its recovery wraps, which are served one at a time
 * by lookup hash (`…/recovery-wrap`), exactly as the live vault's are.
 *
 * Only to the vault's owner, only inside its window, and only to an unlocked
 * session; the same 404 otherwise. Rate limited with the other recovery calls,
 * because these wraps are what an offline guess at the old passphrase needs.
 */
export const GET = authenticatedRoute<{ retainedId: string }>(
  async ({ params, principal, services }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_retained', user.user.id]));
    return json({ retained: await retainedMaterial(services, user, params.retainedId) });
  },
);
