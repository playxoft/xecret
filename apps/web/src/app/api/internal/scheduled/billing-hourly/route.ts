import { runHourlyBillingJob } from '@/server/billing/jobs';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';

/**
 * The hourly billing job (P12), reachable only from the Worker's own Cron
 * Trigger (`worker.ts`, `server/scheduled.ts`) — every request from the
 * internet gets a bare 404 decided before anything is built, exactly as the
 * retained-vault purge beside it does.
 *
 * The job itself is in `server/billing/jobs.ts`: ended cancellations, seat-sync
 * retries, the overage report, the dated reminders. Each step runs whether or
 * not the others failed; if any did, this answers 500 so the scheduled run is
 * marked failed in Cloudflare's own record too.
 */

const run = publicRoute(async ({ services }) => {
  const report = await runHourlyBillingJob(services);
  if (report.failures.length > 0) {
    throw errors.internal(`billing job steps failed: ${report.failures.join(', ')}`);
  }
  return json({
    ended: report.ended,
    seatSyncs: report.seatSyncs,
    unitsReported: report.usage?.units ?? 0,
    reminders: report.reminders,
  });
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return run(request);
}
