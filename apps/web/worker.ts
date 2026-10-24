/**
 * The Worker's entry: OpenNext's generated handler, plus the Cron Triggers.
 *
 * `fetch` is the generated handler unchanged — every request the application
 * serves goes through it exactly as it did when `.open-next/worker.js` was the
 * entry itself. What this file adds is `scheduled`, which wrangler.toml's
 * `[env.production.triggers]` runs on three schedules, and which calls the
 * application's own `fetch` in-process for the internal job routes
 * (`src/server/scheduled.ts` explains why, and why no request from the internet
 * can reach them).
 *
 * Which jobs run is decided by the expression that fired (`jobsForCron`):
 *
 *  - hourly — the retained-vault purge (P23: a vault reset is kept for seven
 *    days and then deleted, and this is what deletes it), then the pruning of
 *    finished webhook deliveries and stale read sightings (P19), then the
 *    billing job (P12);
 *  - every five minutes — webhook retries that are due, then the read-alert
 *    digests whose hour is up (P19 §5, §7);
 *  - nightly — the billing reconciler (P12).
 *
 * Each job runs in isolation: one that fails is reported, and the rest still
 * run (`runScheduledJobs`) — a Dodo outage must never stop the seven-day purge
 * — and the run fails if any job did.
 *
 * This is OpenNext's documented custom-worker pattern
 * (https://opennext.js.org/cloudflare/howtos/custom-worker). The application
 * uses neither the DO queue nor the DO tag cache, so nothing else is re-exported.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the generated file exists only after `opennextjs-cloudflare build`, so `@ts-expect-error` would itself become an error once it does.
// @ts-ignore `.open-next/worker.js` is generated at build time.
import { default as handler } from './.open-next/worker.js';
import { jobsForCron, runScheduledJobs } from './src/server/scheduled';

type AppFetch = (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;

const app = handler as { fetch: AppFetch };

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    // The public origin, so the in-process request resolves exactly as a real
    // one would — and so OpenNext, if this is the isolate's first request,
    // records the right origin for every request after it.
    await runScheduledJobs(
      (request) => app.fetch(request, env, ctx),
      env.XECRET_PUBLIC_URL,
      jobsForCron(controller.cron),
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
