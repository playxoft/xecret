import { timingSafeEqual, toBase64Url } from '@xecret/core/crypto';

/**
 * Scheduled work, run by the Worker's Cron Trigger through the application
 * itself (P23 — the retained-vault purge is the first, and so far only, job).
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
 * And even a caller who got through would achieve nothing it should not: the
 * only job deletes retained vaults whose seven days are over, which is what is
 * due anyway, and migration 0020's triggers refuse anything earlier.
 */

export const SCHEDULED_HEADER = 'x-xecret-scheduled';
export const VAULT_PURGE_PATH = '/api/internal/scheduled/vault-purge';

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
