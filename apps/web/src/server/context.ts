import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createDatabase } from '@xecret/db';
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
 * Per-request services, and the per-isolate caches behind them.
 *
 * Two things are cached for the lifetime of an isolate and two are not, and the
 * split is deliberate:
 *
 * - **Cached:** the database client and the root key provider. Both are
 *   expensive to build, neither can change while an isolate lives, and both are
 *   tenant-independent. Rebuilding them per request would add a connection
 *   handshake and a key import to every single call.
 * - **Not cached:** anything tenant-scoped. An isolate serves requests from
 *   different organisations, so a cache keyed on anything less than the full
 *   tenancy is a cross-tenant leak waiting to happen (threat T2). Unwrapped
 *   environment keys in particular live for exactly one request and are zeroed
 *   after use.
 */

interface IsolateCache {
  database: Database | undefined;
  databaseUrl: string | undefined;
  keyProvider: Promise<KeyProvider> | undefined;
}

const isolate: IsolateCache = {
  database: undefined,
  databaseUrl: undefined,
  keyProvider: undefined,
};

function database(env: Bindings): Database {
  const url = connectionString(env);

  // Keyed on the URL so a Hyperdrive rebind — or a developer switching
  // databases in `next dev` — cannot be served by a stale client.
  if (isolate.database && isolate.databaseUrl === url) return isolate.database;

  isolate.database = createDatabase({ connectionString: url });
  isolate.databaseUrl = url;
  return isolate.database;
}

/**
 * Resolves the Root KEK provider.
 *
 * The Secrets Store binding is the production path. `XECRET_ROOT_KEYS` as a
 * plain variable is the local and self-hosted path, and reaches the process via
 * `phase run` rather than a committed file.
 *
 * The promise is cached rather than the resolved value so that concurrent
 * requests during a cold start share one Secrets Store read instead of racing.
 */
function keyProvider(env: Bindings): Promise<KeyProvider> {
  if (isolate.keyProvider) return isolate.keyProvider;

  const version = Number(env.XECRET_ROOT_KEY_VERSION ?? '1');

  const resolved: Promise<KeyProvider> = env.XECRET_ROOT_KEYS
    ? keyProviderFromSecretsStore(requireBinding(env, 'XECRET_ROOT_KEYS'), version)
    : Promise.resolve(
        keyProviderFromEnv({
          XECRET_ROOT_KEYS: process.env['XECRET_ROOT_KEYS'],
          XECRET_ROOT_KEY_VERSION: env.XECRET_ROOT_KEY_VERSION,
        }),
      );

  // A failed load must not be memoised: a transient Secrets Store error would
  // otherwise poison the isolate until it is recycled, turning a blip into an
  // outage for every request that isolate goes on to serve.
  isolate.keyProvider = resolved.catch((cause: unknown) => {
    isolate.keyProvider = undefined;
    throw cause;
  });

  return isolate.keyProvider;
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

  return {
    env: worker.env,
    db: database(worker.env),
    envelope: new EnvelopeService(await keyProvider(worker.env)),
    meta: {
      requestId,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
      method: request.method,
      path: url.pathname,
    },
    waitUntil: (promise) => worker.ctx.waitUntil(promise),
  };
}

/**
 * Discards the isolate's caches.
 *
 * Exists for tests. Production has no reason to call it: an isolate that needs
 * fresh configuration is replaced, not repaired.
 */
export function resetIsolateCacheForTesting(): void {
  isolate.database = undefined;
  isolate.databaseUrl = undefined;
  isolate.keyProvider = undefined;
}
