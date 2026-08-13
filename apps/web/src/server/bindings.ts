/**
 * The Cloudflare bindings xecret expects at runtime, and typed access to them.
 *
 * This module is deliberately free of any import from the OpenNext adapter, so
 * it is a plain typed description of configuration that can be unit-tested under
 * Node. `context.ts` is the single place that reaches into the live Worker
 * context — keeping that to one file is what makes "where does runtime
 * configuration enter the system?" answerable by grep.
 *
 * `wrangler types` regenerates `src/cloudflare-env.d.ts` from `wrangler.jsonc`,
 * but only for bindings that are actually declared there. xecret's bindings stay
 * commented out until the underlying Cloudflare resources exist, because wrangler
 * fails a deploy on a binding that points at nothing. This declaration merge
 * fills the gap: the shapes are agreed and typechecked now, and every one is
 * optional so the code must decide what to do when a binding is absent rather
 * than assuming it is there.
 *
 * When a resource is created and uncommented in `wrangler.jsonc`, the generated
 * type takes over and this block can shed that entry.
 */
declare global {
  interface CloudflareEnv {
    /**
     * Pooled connection to Neon. Hyperdrive keeps the pool at the edge, so the
     * database does not consume one of the six outgoing connections a Worker
     * invocation is allowed (ADR 0006).
     */
    HYPERDRIVE?: Hyperdrive;

    /**
     * The Root KEK map, as JSON: `{"1":"<base64url>","2":"…"}`.
     *
     * Originates in Phase.dev and is pushed to Cloudflare Secrets Store at
     * deploy time. It is never fetched over the network while serving a request
     * (ADR 0002).
     */
    XECRET_ROOT_KEYS?: SecretsStoreSecret;

    /** Which root key version new wrapping operations use. Defaults to 1. */
    XECRET_ROOT_KEY_VERSION?: string;

    /**
     * Caches Google's Firebase signing keys (JWKS).
     *
     * Without it, verifying an ID token costs an outgoing fetch — spending one
     * of six connections on the login path, on every cold isolate.
     */
    JWKS_CACHE?: KVNamespace;

    /**
     * Firebase project id. Not a secret: it is embedded in every client bundle.
     * It is still required server-side, because it is the `aud` claim an ID
     * token must carry, and skipping that check would accept a token minted for
     * a different Firebase project.
     */
    FIREBASE_PROJECT_ID?: string;

    /**
     * Direct database URL, for local development and self-hosters without
     * Hyperdrive. Ignored whenever `HYPERDRIVE` is present.
     */
    DATABASE_URL?: string;

    RL_LOGIN?: RateLimit;
    RL_CLI_TOKEN?: RateLimit;
    RL_INVITE?: RateLimit;
    RL_SECRET_READ?: RateLimit;
    RL_SERVICE?: RateLimit;
    RL_MUTATION?: RateLimit;
  }
}

export type Bindings = CloudflareEnv;

export interface WorkerContext {
  env: Bindings;
  /** `waitUntil` lets audit writes finish after the response is sent. */
  ctx: Pick<ExecutionContext, 'waitUntil'>;
}

/**
 * Raised when a binding the current code path genuinely needs is missing.
 *
 * Deliberately not a generic `Error`: a missing binding is an operator
 * configuration fault, not a user error, and the route layer maps it to a 503
 * with no detail rather than a 500 that looks like a bug in the request.
 */
export class MissingBindingError extends Error {
  constructor(readonly binding: string) {
    super(`Binding ${binding} is not configured`);
    this.name = 'MissingBindingError';
  }
}

export function requireBinding<K extends keyof Bindings>(
  env: Bindings,
  name: K,
): NonNullable<Bindings[K]> {
  const value = env[name];
  if (value === undefined || value === null) throw new MissingBindingError(String(name));
  return value as NonNullable<Bindings[K]>;
}

/**
 * The connection string for this deployment.
 *
 * Hyperdrive wins when present. Falling back to `DATABASE_URL` is what lets a
 * self-hoster run without Hyperdrive, and what lets `next dev` talk to a local
 * PostgreSQL instance — but only one of the two is ever in play, so there is no
 * ambiguity about which database a request reached.
 */
export function connectionString(env: Bindings, processUrl?: string | undefined): string {
  if (env.HYPERDRIVE) return env.HYPERDRIVE.connectionString;
  if (env.DATABASE_URL) return env.DATABASE_URL;

  // Third, and only for local development: the process environment.
  //
  // Under `next dev` the OpenNext adapter builds `env` from `wrangler.jsonc`
  // and `.dev.vars` — deliberately, since that is what a deployed Worker sees.
  // It does not include the shell's environment, so `phase run -- npm run dev`
  // reaches `process.env` and never reaches `env`. Without this the dev server
  // answers 503 while the same value works everywhere else, which is a
  // genuinely baffling half-hour.
  //
  // Passed in rather than read here so this function stays pure: reading
  // ambient state would make its unit tests depend on whoever runs them having
  // no DATABASE_URL exported. `context.ts` supplies it, next to the identical
  // fallback for root keys.
  if (processUrl) return processUrl;

  throw new MissingBindingError('HYPERDRIVE or DATABASE_URL');
}

export function isProductionDeployment(env: Bindings): boolean {
  return env.XECRET_ENV === 'production';
}

/**
 * The origin this deployment serves.
 *
 * Used for cookie scoping, CLI redirect validation, and the `Origin` header
 * check on mutations. It comes from configuration rather than from the request's
 * own `Host` header on purpose: trusting `Host` would let an attacker who can
 * reach the Worker choose the origin the security checks compare against.
 */
export function publicOrigin(env: Bindings): string {
  return env.XECRET_PUBLIC_URL;
}
