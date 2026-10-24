import { pruneReadSightings, pruneWebhookDeliveries } from '@xecret/db/repositories';
import { json } from '@/server/http';
import { describeError } from '@/server/logging';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';

/**
 * The hourly pruning, reachable only from the Worker's own Cron Trigger
 * (`worker.ts`, `server/scheduled.ts`), after the vault purge:
 *
 *  - **Webhook deliveries** finished — succeeded or abandoned — more than
 *    {@link DELIVERY_RETENTION_DAYS} days ago. The delivery log is a log, not an
 *    archive; one still owed a retry is never pruned, however old.
 *  - **Read sightings** not seen for {@link SIGHTING_RETENTION_DAYS} days. An
 *    address pruned this way is "new" again the next time it reads, which is
 *    the right answer for one nobody has seen in six months.
 *
 * Anything else — every request from the internet — gets a bare 404 with no
 * body, decided before anything is built. Each pruning is independent: one
 * that fails is logged and answered as `null`, and the other still runs.
 */

/** How long a finished delivery stays in the log. Not exported: a route file exports its handlers. */
const DELIVERY_RETENTION_DAYS = 30;
/** How long an address may go unseen before it is forgotten. */
const SIGHTING_RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;

const prune = publicRoute(async ({ services }) => {
  const log = services.log.at('scheduled');

  let webhookDeliveries: number | null;
  try {
    webhookDeliveries = await pruneWebhookDeliveries(
      services.db,
      new Date(Date.now() - DELIVERY_RETENTION_DAYS * DAY_MS),
    );
  } catch (cause) {
    log.error('Could not prune old webhook deliveries; they wait for the next run', {
      error: describeError(cause),
    });
    webhookDeliveries = null;
  }

  let readSightings: number | null;
  try {
    readSightings = await pruneReadSightings(
      services.db,
      new Date(Date.now() - SIGHTING_RETENTION_DAYS * DAY_MS),
    );
  } catch (cause) {
    log.error('Could not prune stale read sightings; they wait for the next run', {
      error: describeError(cause),
    });
    readSightings = null;
  }

  return json({ webhookDeliveriesPruned: webhookDeliveries, readSightingsPruned: readSightings });
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return prune(request);
}
