import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';
import { purgeRetainedVaults } from '@/server/vault-purge';

/**
 * The hourly retained-vault purge, reachable only from the Worker's own Cron
 * Trigger (`worker.ts`, `server/scheduled.ts`).
 *
 * Anything else — every request from the internet — gets the same 404 an
 * unknown path gets: it carries no nonce minted for a scheduled run in this
 * isolate, and outside such a run there is none to carry. There is no route in
 * the product that deletes a retained vault early, and this is not one either:
 * it deletes only vaults whose seven days are over, and the database refuses
 * anything else.
 */
export const POST = publicRoute(async ({ request, services }) => {
  if (!isScheduledRequest(request)) throw errors.notFound('no such route');
  return json({ purged: await purgeRetainedVaults(services) });
});
