import { json } from '@/server/http';
import { listRetained } from '@/server/retained-vault-service';
import { authenticatedRoute } from '@/server/route';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * The account's reset vaults that are still inside their seven-day window
 * (P23): when each was reset, when it may be purged, and how many keys it
 * holds. Nothing secret, and nothing that opens anything.
 *
 * Behind the vault lock, like every recovery endpoint: recovering re-seals the
 * old keys to the current vault, which needs the current vault open.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  const user = requireUserPrincipal(principal);
  return json({ retained: await listRetained(services, user) });
});
