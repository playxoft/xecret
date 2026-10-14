import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';
import { purgeRetainedVaults } from '@/server/vault-purge';

/**
 * The hourly retained-vault purge, reachable only from the Worker's own Cron
 * Trigger (`worker.ts`, `server/scheduled.ts`).
 *
 * Anything else — every request from the internet — gets a bare 404 with no
 * body, decided before anything is built: no service context, no database
 * connection, no log line, no request id. It carries no nonce minted for a
 * scheduled run in this isolate, and outside such a run there is none to
 * carry, so the only work an outside request can cause here is one header
 * comparison.
 *
 * There is no route in the product that deletes a retained vault early, and
 * this is not one either: it deletes only vaults whose seven days are over, by
 * the database's own clock, and the database refuses anything else.
 */
const purge = publicRoute(async ({ services }) =>
  json({ purged: await purgeRetainedVaults(services) }),
);

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return purge(request);
}
