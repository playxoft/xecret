import { purgeDeletedData } from '@/server/deleted-data-purge';
import { json } from '@/server/http';
import { publicRoute } from '@/server/route';
import { isScheduledRequest } from '@/server/scheduled';

/**
 * The nightly deleted-data purge, reachable only from the Worker's own Cron
 * Trigger (`worker.ts`, `server/scheduled.ts`); every request from the
 * internet gets a bare 404, decided before anything is built.
 *
 * Erases organisations, projects, environments and secrets deleted at least
 * thirty days ago — see `server/deleted-data-purge.ts`. There is no route in
 * the product that erases anything sooner, and this is not one either: every
 * cutoff is the database's own clock, re-checked under the row's lock.
 *
 * Answers 500 when any erasure failed, after attempting all of them, so the
 * Cron Trigger's history shows the failed run; the report names only counts.
 */

const run = publicRoute(async ({ services }) => {
  const report = await purgeDeletedData(services);
  return json(report, { status: report.failed > 0 ? 500 : 200 });
});

export async function POST(request: Request): Promise<Response> {
  if (!isScheduledRequest(request)) return new Response(null, { status: 404 });
  return run(request);
}
