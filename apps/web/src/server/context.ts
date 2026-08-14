import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createDatabaseHandle } from '@xecret/db';
import type { Database } from '@xecret/db';
import {
  EnvelopeService,
  keyProviderFromEnv,
  keyProviderFromSecretsStore,
} from '@xecret/core/crypto';
import type { KeyProvider } from '@xecret/core/crypto';
import { connectionString, requireBinding, withProcessFallbacks } from './bindings';
import type { Bindings, WorkerContext } from './bindings';
import { clientIp, userAgent } from './http';

/**
 * Per-request services.
 *
 * ── What is cached per isolate, and what must never be ──
 *
 * The **root key provider** is cached: it is plain data — imported CryptoKeys
 * and a version number — and importing it per request would add a Secrets
 * Store read and a key import to every call for no gain. Only a *settled*
 * provider is ever cached, never a pending promise: a promise started by one
 * request and awaited by another is cross-request I/O, which workerd forbids.
 *
 * The **database client** is deliberately NOT cached, and this is a hard
 * runtime rule rather than a preference. A postgres connection is a TCP
 * socket, and workerd cancels any attempt to use a socket outside the request
 * that opened it — "Cannot perform I/O on behalf of a different request". A
 * cached client serves the first request on an isolate and wedges every one
 * after it; in production that read as the Worker hanging until the runtime
 * killed it. One handle per request, disposed after the response, is the
 * supported model — and the per-request handshake is exactly the cost
 * Hyperdrive exists to absorb (it terminates at the edge proxy, not at Neon).
 *
 * Nothing tenant-scoped is cached at all: an isolate serves requests from
 * different organisations, so a cache keyed on anything less than the full
 * tenancy is a cross-tenant leak waiting to happen (threat T2). Unwrapped
 * environment keys in particular live for exactly one request.
 */

let cachedKeyProvider: KeyProvider | undefined;

async function keyProvider(env: Bindings): Promise<KeyProvider> {
  if (cachedKeyProvider) return cachedKeyProvider;

  const version = Number(env.XECRET_ROOT_KEY_VERSION ?? '1');

  // Two concurrent cold-start requests may both reach this point and each
  // perform its own read. That duplication is the deliberate trade: each
  // request awaits only I/O it started itself, so neither can be poisoned or
  // cancelled by the other's lifecycle. Last writer wins; the values are
  // identical.
  const provider: KeyProvider = env.XECRET_ROOT_KEYS
    ? await keyProviderFromSecretsStore(requireBinding(env, 'XECRET_ROOT_KEYS'), version)
    : keyProviderFromEnv({
        XECRET_ROOT_KEYS: process.env['XECRET_ROOT_KEYS'],
        XECRET_ROOT_KEY_VERSION: env.XECRET_ROOT_KEY_VERSION,
      });

  cachedKeyProvider = provider;
  return provider;
}

/**
 * Returns the current request's bindings and execution context.
 *
 * `async: true` is required: Next.js may run a route handler outside the
 * synchronous request scope, where the synchronous form throws.
 *
 * This is the only call into the OpenNext adapter in the codebase, and the only
 * place in the server layer that reads `process.env` — so "where does runtime
 * configuration enter the system?" has exactly one answer, and the precedence
 * between a binding and an environment variable is decided once rather than at
 * each call site.
 */
export async function workerContext(): Promise<WorkerContext> {
  const { env, ctx } = await getCloudflareContext({ async: true });
  return { env: withProcessFallbacks(env, process.env), ctx };
}

/** Request-scoped facts that every audit record and log line carries. */
export interface RequestMeta {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  method: string;
  path: string;
}

export interface ServiceContext {
  env: Bindings;
  db: Database;
  envelope: EnvelopeService;
  meta: RequestMeta;
  /** Defers work until after the response is sent — used for audit flushes. */
  waitUntil: (promise: Promise<unknown>) => void;
  /**
   * Schedules the release of the request's database handle.
   *
   * Called exactly once, by the route wrapper, in its `finally`. The close is
   * deferred through the runtime's own `waitUntil` — deliberately not the
   * tracked one, which would make the close await itself — and runs only
   * after everything this request queued through `waitUntil` has settled:
   * audit writes, session touches, token-usage bookkeeping. Those tasks use
   * this same connection, and closing it underneath them would silently drop
   * the records that matter most.
   */
  dispose: () => void;
}

/**
 * Builds the per-request services.
 *
 * `requestId` is supplied by the caller rather than derived here, because the
 * route wrapper needs it before this function runs — it must be able to answer
 * a failure that happens *while building this context*. Deriving it in both
 * places would let the id in the response header differ from the id in the audit
 * records for the same request, which defeats the only purpose the id has.
 */
export async function createServiceContext(
  request: Request,
  worker: WorkerContext,
  requestId: string,
): Promise<ServiceContext> {
  const url = new URL(request.url);

  const handle = createDatabaseHandle({ connectionString: connectionString(worker.env) });

  // Everything handed to `waitUntil` is also tracked here, so `dispose` can
  // sequence the connection close *after* the deferred work that needs it.
  // Rejections are absorbed in the tracking copy only — each task still owns
  // its own failure handling via the promise given to the runtime.
  const pending: Promise<unknown>[] = [];

  return {
    env: worker.env,
    db: handle.db,
    envelope: new EnvelopeService(await keyProvider(worker.env)),
    meta: {
      requestId,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
      method: request.method,
      path: url.pathname,
    },
    waitUntil: (promise) => {
      pending.push(promise.catch(() => undefined));
      worker.ctx.waitUntil(promise);
    },
    dispose: () => {
      worker.ctx.waitUntil(
        (async () => {
          await Promise.allSettled(pending);
          // A close failure is unreportable by now — the response is gone and
          // the socket dies with the request context regardless.
          await handle.end().catch(() => undefined);
        })(),
      );
    },
  };
}

/**
 * Discards the isolate's caches.
 *
 * Exists for tests. Production has no reason to call it: an isolate that needs
 * fresh configuration is replaced, not repaired.
 */
export function resetIsolateCacheForTesting(): void {
  cachedKeyProvider = undefined;
}
