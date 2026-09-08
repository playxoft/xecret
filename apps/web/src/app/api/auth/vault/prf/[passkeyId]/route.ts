import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { removePasskey, requireUserPrincipal } from '@/server/vault-service';

/**
 * Unenrolling a passkey. Its `prf` wrap goes with it, by cascade.
 *
 * This can never strand an account: the passphrase wrap always exists and has no
 * removal path, so the last passkey is still not the last way in. No "are you
 * sure, this is your only unlock method" guard is needed because the state it
 * would guard against is unreachable.
 *
 * The id is scoped by user in the repository's `WHERE`, so one account cannot
 * delete another's credential by guessing a uuid — and an id belonging to
 * somebody else answers exactly the same 404 as one belonging to nobody
 * (threat T2).
 */
export const DELETE = authenticatedRoute<{ passkeyId: string }>(
  async ({ params, principal, services }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

    await removePasskey(services, user, params.passkeyId);
    return noContent();
  },
);
