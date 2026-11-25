import { timingSafeEqual, toBase64Url } from '@xecret/core/crypto';

/**
 * Scheduled work, run by the Worker's Cron Triggers through the application
 * itself: on every run, the retained-vault purge (P23), the pruning of old
 * webhook deliveries and read sightings (P19 §5, §7), webhook retries and
 * read-alert digests (P19 §5, §7) and the billing job (P12); once a day, after
 * those, the deleted-data purge and then the billing reconciler (P12).
 * `jobsForCron` is which runs when.
 *
 * ── Why twice a day ──
 * Every run queries the database, and the database is Neon on its free plan:
 * the compute scales to zero only after five minutes without a query, and the
 * plan allows 100 compute-hours a month. The five-minute run this replaced
 * fired just as each five quiet minutes ran out, so the compute never slept —
 * 347 of the first 348 hours of November 2026, 89% of the month's allowance in
 * two weeks. Now there are two runs a day, 10:17 and 22:17 UTC, each one wake
 * of about five minutes — the once-a-day work rides on the morning run rather
 * than waking the database a third time.
 *
 * It is a dial, not a design: "hourly" in the billing job's name, and "the
 * next run" throughout, mean whatever the two expressions below say. With real
 * traffic keeping the compute awake anyway, every three hours or every hour
 * costs little more: widen {@link PERIODIC_CRON} — `17 1,4,7,13,16,19,22 * * *`
 * or `17 0-9,11-23 * * *`, never naming {@link DAILY_CRON}'s hour, or the
 * billing job runs twice side by side — here and in `wrangler.toml`.
 *
 * Turn it up before volume arrives, not after: the per-run limits were sized
 * for frequent runs and are now also the day's ceiling — twenty seconds of
 * webhook sends (`WEBHOOK_SWEEP_BUDGET_MS`), fifty organisations' digests
 * (`READ_ALERT_SWEEP_ORGS`), fifty seat-sync debts, 5,000 metered units per
 * organisation. Nothing is lost past them, only later; a backlog that
 * survives a run in the logs is the signal. Every job also shares the one
 * invocation's CPU and subrequest budget, the reconciler last of all.
 *
 * ── Why through the app rather than beside it ──
 * The scheduled handler lives in `worker.ts`, outside Next. It could open its
 * own database handle and write its own audit records, but that would be a
 * second copy of the database wiring, the logger and the audit sink — bundled a
 * second time into the Worker — for jobs that run a few times a day. Instead it
 * calls the application's own `fetch` in-process with a request for an internal
 * route, and the job runs with exactly the services every request gets.
 *
 * ── Why nobody else can call that route ──
 * The route answers 404 unless the request carries a nonce the scheduled
 * handler minted for this one call: 32 random bytes, added to a set on
 * `globalThis` before the call and removed after it. The request never leaves
 * the isolate — it is a function call, not a network hop — so the nonce is in
 * no log, no header on the wire, and no other isolate. A request from the
 * internet cannot know it, and outside a scheduled run there is none to know.
 *
 * And even a caller who got through would achieve nothing it should not: every
 * job does only what is due anyway — deletes retained vaults whose seven days
 * are over (migration 0020's triggers refuse anything earlier), erases data
 * deleted thirty or more days ago (by the database's clock), prunes rows
 * past their age, sends deliveries and digests that are owed; the billing jobs
 * report units with deterministic ids Dodo deduplicates, send reminders
 * deduplicated by their own table, and compare rows without correcting them.
 */

export const SCHEDULED_HEADER = 'x-xecret-scheduled';
export const VAULT_PURGE_PATH = '/api/internal/scheduled/vault-purge';
/** Every run: old webhook deliveries and old read sightings. */
export const PRUNE_PATH = '/api/internal/scheduled/prune';
/** P12, every run: ended cancellations, seat-sync retries, the overage report, the dated reminders. */
export const BILLING_HOURLY_PATH = '/api/internal/scheduled/billing-hourly';
/** Every run: webhook retries, then read-alert digests. */
export const NOTIFICATIONS_PATH = '/api/internal/scheduled/notifications';
/** Daily: erases what was deleted thirty or more days ago (`server/deleted-data-purge.ts`). */
export const DELETED_DATA_PURGE_PATH = '/api/internal/scheduled/deleted-data-purge';
/** P12, daily: the comparison with Dodo, alert-only. */
export const BILLING_DAILY_PATH = '/api/internal/scheduled/billing-daily';

/**
 * The two expressions in `wrangler.toml`'s `[env.production.triggers]`,
 * exactly. Kept beside the paths so the schedule and what it runs are read in
 * one place; `worker.ts` dispatches on `controller.cron`, which is exactly one
 * of these strings.
 *
 * {@link DAILY_CRON} runs everything {@link PERIODIC_CRON} does and then the
 * once-a-day work, in one invocation, so the reconciler never compares rows
 * the billing job is still changing. Its hour is the billing job's
 * `CARD_CHECK_HOUR_UTC` (`billing/jobs.ts`), the one run that checks cards: a
 * schedule without that hour would stop every card-expiry reminder without an
 * error anywhere.
 */
export const PERIODIC_CRON = '17 22 * * *';
export const DAILY_CRON = '17 10 * * *';

/**
 * Every run's jobs, in order: the ones that touch only the database first, then
 * the deliveries and digests, then the one that calls Dodo, so a slow or
 * failing billing provider never delays the seven-day purge or the pruning
 * (each job runs in isolation regardless — `runScheduledJobs`).
 */
const PERIODIC_JOBS: readonly string[] = [
  VAULT_PURGE_PATH,
  PRUNE_PATH,
  NOTIFICATIONS_PATH,
  BILLING_HOURLY_PATH,
];

/**
 * Which jobs a Cron Trigger runs, in order, by the expression that fired it.
 *
 * Anything that is not the daily expression runs the periodic jobs. That is
 * the safe default in the direction that matters: the periodic jobs are
 * idempotent — they do only what is already due — so an expression edited in
 * `wrangler.toml` and not here runs them more often than it needs to, which
 * costs a few queries, rather than not at all, which would leave retained
 * vaults past their window undeleted.
 */
export function jobsForCron(cron: string): readonly string[] {
  if (cron === DAILY_CRON) return [...PERIODIC_JOBS, DELETED_DATA_PURGE_PATH, BILLING_DAILY_PATH];
  return PERIODIC_JOBS;
}

/**
 * Runs several jobs, one after another, each in isolation: one that fails is
 * reported and the next still runs. Throws once all have run if any failed, so
 * the invocation is marked failed in the platform's own cron history.
 *
 * In sequence rather than at once: each job is a request with its own database
 * connection, and a scheduled invocation shares the same six-connection budget
 * as any other.
 */
export async function runScheduledJobs(
  fetchApp: (request: Request) => Promise<Response>,
  origin: string,
  paths: readonly string[],
): Promise<void> {
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await runScheduledJob(fetchApp, origin, path);
    } catch (cause) {
      // `runScheduledJob`'s own sentence — a path and a status — or the name of
      // whatever the in-process call threw. Never a response body.
      failed.push(cause instanceof Error ? cause.message : path);
    }
  }
  if (failed.length > 0) throw new Error(`Scheduled jobs failed: ${failed.join('; ')}`);
}

const NONCES = Symbol.for('xecret.scheduled-nonces');

function nonces(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (store[NONCES] ??= new Set<string>());
}

/** Runs one scheduled job by calling the app in-process. Throws when it did not succeed. */
export async function runScheduledJob(
  fetchApp: (request: Request) => Promise<Response>,
  origin: string,
  path: string,
): Promise<void> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  nonces().add(nonce);
  try {
    const response = await fetchApp(
      new Request(new URL(path, origin), {
        method: 'POST',
        headers: { [SCHEDULED_HEADER]: nonce },
      }),
    );
    if (!response.ok) {
      throw new Error(`Scheduled job ${path} answered ${response.status}`);
    }
  } finally {
    nonces().delete(nonce);
  }
}

/** Whether this request is one `runScheduledJob` is making right now. */
export function isScheduledRequest(request: Request): boolean {
  const presented = request.headers.get(SCHEDULED_HEADER);
  if (presented === null) return false;

  const encoder = new TextEncoder();
  const presentedBytes = encoder.encode(presented);
  for (const nonce of nonces()) {
    if (timingSafeEqual(presentedBytes, encoder.encode(nonce))) return true;
  }
  return false;
}
