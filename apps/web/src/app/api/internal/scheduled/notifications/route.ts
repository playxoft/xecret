import { json } from '@/server/http';
import { describeError } from '@/server/logging';
import { sweepReadAlertDigests } from '@/server/read-alerts';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';
import { sweepWebhookDeliveries } from '@/server/webhooks-service';

/**
 * The five-minute notifications run, reachable only from the Worker's own Cron
 * Trigger (`worker.ts`, `server/scheduled.ts`): webhook deliveries that are
 * due, then read-alert digests whose hour is up (P19 §5, §7).
 *
 * Anything else — every request from the internet — gets a bare 404 with no
 * body, decided before anything is built, exactly as the vault purge does.
 *
 * The two jobs are independent: a failure in one is logged, answered as `null`
 * in its field, and does not stop the other. Neither can do anything early —
 * a delivery is attempted only once it is due, a digest only once the
 * organisation's hour is up — so a caller who somehow got through would only
 * cause what was about to happen anyway.
 */

const run = publicRoute(async ({ services }) => {
  const log = services.log.at('scheduled');

  let webhookDeliveries: number | null;
  try {
    webhookDeliveries = await sweepWebhookDeliveries(services);
  } catch (cause) {
    log.error('The webhook delivery sweep failed; due deliveries wait for the next run', {
      error: describeError(cause),
    });
    webhookDeliveries = null;
  }

  let readAlertDigests: number | null;
  try {
    readAlertDigests = await sweepReadAlertDigests(services);
  } catch (cause) {
    log.error('The read-alert digest sweep failed; owed digests wait for the next run', {
      error: describeError(cause),
    });
    readAlertDigests = null;
  }

  return json({ webhookDeliveries, readAlertDigests });
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return run(request);
}
