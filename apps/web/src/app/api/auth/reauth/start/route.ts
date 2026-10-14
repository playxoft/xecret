import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { startReauth } from '@/server/reauth-service';
import { authenticatedRoute } from '@/server/route';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * Emails a one-time code to the session's own address — the vault reset's
 * second lock, requestable only once the first (a forced fresh sign-in) is in
 * place. See `server/reauth-service.ts`.
 *
 * Rate limited per account, not per address: what is being spent is mail to
 * somebody's inbox, which belongs to them rather than to whoever is asking, so
 * the address has no business in the key (see `attemptKey`). The limiter is per
 * location and fails open, so it is not what bounds the mail: `startReauth`
 * reserves each request against a per-attempt cap in the database first.
 */
export const POST = authenticatedRoute(
  async ({ principal, services }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['reauth_start', user.user.id]));

    await startReauth(services, user);
    return noContent();
  },
  { allowLocked: true },
);
