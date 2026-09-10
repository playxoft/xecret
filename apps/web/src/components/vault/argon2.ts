'use client';

import { nobleArgon2idProvider } from '@xecret/core/crypto/client';
import type { Argon2idParams, Argon2idProvider, Bytes } from '@xecret/core/crypto/client';
import type { DeriveResponse } from './argon2-worker';

/**
 * The application's Argon2id provider: a worker when there is one, this thread
 * when there is not.
 *
 * ── The decision, and how it was reached ──
 * Next 16's bundler emits a chunk for `new Worker(new URL('./x.ts',
 * import.meta.url))` — the pattern is documented alongside the magic comments in
 * the Turbopack reference, and `worker-src 'self' blob:` in `lib/csp.ts` already
 * permits it. So the worker is the default, because a second of frozen main
 * thread is a second in which the "Securing your vault…" state cannot animate
 * and no click is acknowledged.
 *
 * It is not, however, load-bearing. A worker is a separate network fetch of a
 * separate chunk, and the ways that fetch can fail — a stale deployment serving
 * a hashed filename that no longer exists, an extension or corporate proxy
 * refusing it, a browser with workers disabled — are all failures that would
 * otherwise turn "unlock my vault" into a spinner that never stops. So a worker
 * that does not announce itself within {@link WORKER_READY_TIMEOUT_MS}, or that
 * cannot be constructed at all, falls back to `@noble/hashes` on this thread.
 * The result is byte-identical either way; only the frame rate differs.
 *
 * The fallback is a real path, not a theoretical one: it is also what runs under
 * Vitest, where there is no bundler to emit the chunk.
 */

/**
 * How long a freshly constructed worker has to say `ready`.
 *
 * Generous on purpose. This is a chunk fetch on a connection that may be slow,
 * and the cost of waiting too long is a delayed unlock, while the cost of giving
 * up too early is a main thread that freezes for a second on a device that had a
 * perfectly good worker coming. A derivation takes about that long anyway.
 */
export const WORKER_READY_TIMEOUT_MS = 3_000;

/** How long the derivation itself may take before the worker is written off. */
export const WORKER_DERIVE_TIMEOUT_MS = 60_000;

/**
 * Whether a worker has already failed us.
 *
 * Sticky, and module-scoped: if the chunk cannot be fetched once it will not be
 * fetchable on the next unlock either, and paying the ready-timeout again before
 * every derivation would add three seconds to each of them.
 */
let workersUnavailable = false;

/**
 * How a worker is constructed.
 *
 * ── Why this is a variable and not a `new` expression inline ──
 * The construction is the one line here that a test cannot exercise: `new
 * Worker(new URL(…, import.meta.url))` is a *bundler instruction*, and under
 * Vitest there is no bundler to emit the chunk — the call throws, the provider
 * falls back, and every decision below it goes unobserved. That is not a small
 * gap: what this module actually decides is when to give up on a worker, whether
 * giving up is remembered, and which failures are infrastructural (fall back)
 * versus the worker's own verdict (rethrow, because this thread would reject the
 * same input identically). All three are pure logic sitting behind one
 * untestable expression.
 *
 * Naming the seam moves the untestable part to a single default and leaves the
 * logic reachable. Production never touches the setter.
 */
export type Argon2WorkerFactory = () => Worker;

const defaultWorkerFactory: Argon2WorkerFactory = () =>
  new Worker(new URL('./argon2-worker.ts', import.meta.url), { type: 'module' });

let workerFactory: Argon2WorkerFactory = defaultWorkerFactory;

/**
 * Replaces how workers are made, and clears the sticky failure. Test-facing.
 *
 * `null` restores the real factory. The sticky flag is cleared on every call
 * because a test that swapped the factory and inherited a previous test's
 * "workers are unavailable" would be asserting the fallback path while believing
 * it was asserting the worker one.
 */
export function setArgon2WorkerFactory(factory: Argon2WorkerFactory | null): void {
  workerFactory = factory ?? defaultWorkerFactory;
  workersUnavailable = false;
}

/** Whether a worker has been written off for the life of this page. Test-facing. */
export function argon2WorkersUnavailable(): boolean {
  return workersUnavailable;
}

/**
 * Argon2id at the caller's parameters.
 *
 * Signature-compatible with {@link Argon2idProvider}, so it drops straight into
 * `deriveStretchedKey({ argon2id })` — the seam `packages/core` defined for
 * exactly this.
 */
export const argon2idProvider: Argon2idProvider = async (password, salt, params) => {
  if (!workersUnavailable) {
    const key = await deriveInWorker(password, salt, params);
    if (key !== null) return key;
    workersUnavailable = true;
  }

  return nobleArgon2idProvider(password, salt, params);
};

/**
 * One derivation in one worker, or `null` if the worker could not do it.
 *
 * `null` rather than a throw for every *infrastructural* failure — construction,
 * load, timeout — because those are the cases the caller answers by deriving
 * here instead. A failure reported by the worker *itself* is different: the
 * parameters or the implementation rejected the input, and this thread would
 * reject it identically, so it is rethrown rather than retried.
 */
async function deriveInWorker(
  password: Bytes,
  salt: Bytes,
  params: Argon2idParams,
): Promise<Bytes | null> {
  let worker: Worker;
  try {
    worker = workerFactory();
  } catch {
    // No `Worker` at all, or a bundler that did not emit the chunk.
    return null;
  }

  try {
    return await new Promise<Bytes | null>((resolve, reject) => {
      let ready = false;

      const timer = setTimeout(
        () => resolve(null),
        // Two deadlines from one timer: the short one until the worker speaks,
        // the long one for the work itself.
        WORKER_READY_TIMEOUT_MS,
      );

      let deriveTimer: ReturnType<typeof setTimeout> | null = null;

      worker.addEventListener('message', (event: MessageEvent<DeriveResponse>) => {
        const message = event.data;

        if (message.ok === 'ready') {
          if (ready) return;
          ready = true;
          clearTimeout(timer);
          deriveTimer = setTimeout(() => resolve(null), WORKER_DERIVE_TIMEOUT_MS);
          worker.postMessage({ password, salt, params });
          return;
        }

        if (deriveTimer !== null) clearTimeout(deriveTimer);
        clearTimeout(timer);

        if (message.ok) resolve(message.key);
        else reject(new Error(`Argon2id failed in the worker (${message.message})`));
      });

      // A worker that errors after `ready` has still not produced a key, and the
      // honest response is the same as never having had one: derive here.
      worker.addEventListener('error', () => {
        clearTimeout(timer);
        if (deriveTimer !== null) clearTimeout(deriveTimer);
        resolve(null);
      });
    });
  } finally {
    // Unconditionally, on every path including the rejection above. The worker
    // holds a copy of the passphrase bytes, and terminating is the only thing
    // that reliably disposes of them.
    worker.terminate();
  }
}
