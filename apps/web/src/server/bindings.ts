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
    XECRET_ROOT_KEY_VERSION?: string | undefined;

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
    FIREBASE_PROJECT_ID?: string | undefined;

    /**
     * Direct database URL, for local development and self-hosters without
     * Hyperdrive. Ignored whenever `HYPERDRIVE` is present.
     */
    DATABASE_URL?: string | undefined;

    /**
     * ZeptoMail's Send Mail token, from the Mail Agent that will send xecret's
     * transactional email. A credential — it authorises sending as your domain.
     */
    ZEPTOMAIL_TOKEN?: string | undefined;

    /**
     * The `From` address. Must be on a domain verified in ZeptoMail, because
     * Zoho refuses a send from an unverified one rather than silently
     * rewriting it.
     */
    ZEPTOMAIL_FROM_ADDRESS?: string | undefined;

    /** The display name beside that address. Defaults to `xecret`. */
    ZEPTOMAIL_FROM_NAME?: string | undefined;

    /**
     * The regional API endpoint.
     *
     * A ZeptoMail token is only valid in the data centre that issued it, so an
     * EU or India account must set this — `https://api.zeptomail.eu/v1.1/email`,
     * `https://api.zeptomail.in/v1.1/email`. Left unset it points at the default
     * host, which is right for most accounts and produces an unexplained 401 for
     * the rest.
     */
    ZEPTOMAIL_API_URL?: string | undefined;

    /**
     * Better Stack source token, from the source's settings page.
     *
     * A credential: it authorises writing into your log stream, and anybody
     * holding it can flood or poison it. Absent means "console only" — see the
     * note in `server/logging/index.ts` about why observability is optional.
     */
    BETTERSTACK_SOURCE_TOKEN?: string | undefined;

    /**
     * The ingest endpoint.
     *
     * Sources created after mid-2024 get a dedicated
     * `https://<id>.betterstackdata.com` host and must use it; posting to the
     * shared default with such a token answers 401 with nothing explaining why.
     * Left unset it points at the shared host, which is right for older sources
     * and wrong in a way that is hard to diagnose for the rest — so `check:env`
     * says so out loud.
     */
    BETTERSTACK_INGEST_URL?: string | undefined;

    /**
     * Overrides the log threshold: `debug`, `info`, `warn` or `error`.
     *
     * Exists so debug can be turned on in production for the duration of an
     * incident by setting a variable, rather than by shipping a deploy while
     * the thing you are trying to observe is happening.
     */
    XECRET_LOG_LEVEL?: string | undefined;

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
export function connectionString(env: Bindings): string {
  if (env.HYPERDRIVE) return env.HYPERDRIVE.connectionString;
  if (env.DATABASE_URL) return env.DATABASE_URL;

  throw new MissingBindingError('HYPERDRIVE or DATABASE_URL');
}

/**
 * Configuration that a secrets manager supplies as plain strings.
 *
 * Everything else in `Bindings` is a real Cloudflare binding — an object the
 * runtime hands over — and cannot come from an environment variable at all.
 */
const PROCESS_SUPPLIED = [
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'XECRET_ROOT_KEY_VERSION',
  'ZEPTOMAIL_TOKEN',
  'ZEPTOMAIL_FROM_ADDRESS',
  'ZEPTOMAIL_FROM_NAME',
  'ZEPTOMAIL_API_URL',
  'BETTERSTACK_SOURCE_TOKEN',
  'BETTERSTACK_INGEST_URL',
  'XECRET_LOG_LEVEL',
] as const;

/**
 * Fills gaps in the Worker's `env` from the process environment.
 *
 * `next dev` under the OpenNext adapter builds `env` from `wrangler.jsonc` and
 * `.dev.vars` — faithfully, since that is exactly what a deployed Worker sees.
 * It therefore does **not** include the shell, so `phase run -- npm run dev`
 * supplies values the application cannot see, and every route answers 503 while
 * the identical configuration works in every script.
 *
 * Done once, over a list, rather than at each call site: the first version of
 * this fixed only `DATABASE_URL`, and the next request failed on
 * `FIREBASE_PROJECT_ID` with the same message for the same reason. A per-value
 * fix guarantees a per-value bug.
 *
 * **A binding always wins.** In production the values below arrive from
 * Hyperdrive, the Secrets Store, and `wrangler.jsonc`; this only fills what is
 * absent, so it cannot override a deployed configuration with a stray variable
 * on an operator's machine.
 *
 * `source` is a parameter rather than a read of `process.env`, so this is pure
 * and its precedence is testable without depending on the tester's shell.
 */
export function withProcessFallbacks(
  env: Bindings,
  source: Record<string, string | undefined>,
): Bindings {
  const merged: Bindings = { ...env };

  for (const key of PROCESS_SUPPLIED) {
    const current = merged[key];
    if (current !== undefined && current !== '') continue;

    const fallback = source[key];
    if (fallback !== undefined && fallback !== '') merged[key] = fallback;
  }

  return merged;
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
