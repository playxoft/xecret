import { timingSafeEqual, toBase64Url } from '@xecret/core/crypto';

/**
 * Scheduled work, run by the Worker's Cron Triggers through the application
 * itself: hourly, the retained-vault purge (P23) and the pruning of old webhook
 * deliveries and read sightings; every five minutes, webhook retries and
 * read-alert digests (P19 §5, §7). `jobsForCron` is which runs when.
 *
 * ── Why through the app rather than beside it ──
 * The scheduled handler lives in `worker.ts`, outside Next. It could open its
 * own database handle and write its own audit records, but that would be a
 * second copy of the database wiring, the logger and the audit sink — bundled a
 * second time into the Worker — for a job that runs once an hour. Instead it
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
 * are over (migration 0020's triggers refuse anything earlier), prunes rows
 * past their age, sends deliveries and digests that are owed.
 */

export const SCHEDULED_HEADER = 'x-xecret-scheduled';
export const VAULT_PURGE_PATH = '/api/internal/scheduled/vault-purge';
/** Hourly: old webhook deliveries and old read sightings. */
export const PRUNE_PATH = '/api/internal/scheduled/prune';
/** Every five minutes: webhook retries, then read-alert digests. */
export const NOTIFICATIONS_PATH = '/api/internal/scheduled/notifications';

/** The two expressions in `wrangler.toml`'s `[env.production.triggers]`, exactly. */
export const HOURLY_CRON = '17 * * * *';
export const FIVE_MINUTE_CRON = '*/5 * * * *';

/**
 * Which jobs a Cron Trigger runs, by the expression that fired it.
 *
 * Anything that is not the five-minute expression runs the hourly jobs. That is
 * the safe default in the direction that matters: the hourly jobs are
 * idempotent — they delete only what is already due — so an expression edited
 * in `wrangler.toml` and not here runs them more often than it needs to, which
 * costs a few queries, rather than not at all, which would leave retained
 * vaults past their window undeleted.
 */
export function jobsForCron(cron: string): readonly string[] {
  return cron === FIVE_MINUTE_CRON ? [NOTIFICATIONS_PATH] : [VAULT_PURGE_PATH, PRUNE_PATH];
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
