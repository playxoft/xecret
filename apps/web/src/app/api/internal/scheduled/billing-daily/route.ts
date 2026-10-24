import { reconcileSubscriptions } from '@/server/billing/reconcile';
import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';

/**
 * The nightly billing reconciler (P12), reachable only from the Worker's own
 * Cron Trigger (`worker.ts`, `server/scheduled.ts`); every request from the
 * internet gets a bare 404.
 *
 * Compares every subscription Dodo bills with our row and reports what
 * differs — alert-only, nothing corrected. See `server/billing/reconcile.ts`.
 */

const run = publicRoute(async ({ services }) => {
  const report = await reconcileSubscriptions(services);
  return json(report);
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return run(request);
}
