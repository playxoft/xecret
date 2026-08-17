/**
 * Facts about this deployment that pages need at *render* time.
 *
 * `publicOrigin()` in `server/bindings.ts` answers the same question for a
 * request handler, reading the Cloudflare binding. It cannot serve this need:
 * every page under `/docs` is prerendered, so its canonical URL, its sitemap
 * entry and its JSON-LD are all decided during `next build`, where no binding
 * exists yet.
 *
 * ── Which makes `XECRET_PUBLIC_URL` two variables wearing one name ──
 * The Worker gets it from `wrangler.jsonc`'s `vars`, which is a *runtime*
 * declaration: nothing about it is present while `next build` runs. So this
 * module reads the build environment, and `scripts/deploy-web.sh` is what puts
 * the value there — it resolves the same `wrangler.jsonc`, for the same `--env`
 * it is about to deploy, and exports the result before building. Build-time and
 * runtime therefore name one origin because they are read from one file, rather
 * than because two places were kept in step by hand.
 *
 * ── Why there is no production fallback any more ──
 * There used to be a constant here naming the production host, used whenever
 * the variable was absent. Absent is exactly what it was during every
 * deployment build, so staging shipped canonical URLs, a `sitemap.xml` and a
 * `robots.txt` `Host` line all pointing at production: the one SEO failure that
 * is invisible on the page and expensive to undo. A build that cannot learn its
 * own origin now says so — loudly if it is building for a deployment, and by
 * falling back to localhost if it is not, which is wrong in a way somebody
 * notices in the first minute rather than in a search index three weeks later.
 */
const LOCAL_ORIGIN = 'http://localhost:3030';

function normaliseOrigin(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Both variables, read as what a build actually finds rather than as what they
 * are declared to be.
 *
 * `cloudflare-env.d.ts` is generated from `wrangler.jsonc` and types these as
 * the exact literals the Worker will be given — never absent, never anything
 * else. That is true of the Worker and false here: `next build` runs wherever
 * somebody runs it, and the whole reason this module exists is that the
 * bindings do not apply to it. Widening to `string | undefined` is what lets
 * the checks below be about the value rather than about the declaration.
 */
function fromBuildEnvironment(name: 'XECRET_PUBLIC_URL' | 'XECRET_ENV'): string | undefined {
  const value: string | undefined = process.env[name];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function buildOrigin(): string {
  const configured = fromBuildEnvironment('XECRET_PUBLIC_URL');
  if (configured !== undefined) return normaliseOrigin(configured);

  // `XECRET_ENV` names the deployment being built for, and is exported from the
  // same `wrangler.jsonc` environment as the URL. Its presence with anything
  // but `development` therefore means "this build is going somewhere real and
  // does not know where", which is not a state to paper over: every canonical
  // on every prerendered page would be wrong, and no test after this point can
  // tell. A local `next build`, a CI bundle-size build and the test runner all
  // leave it unset and get localhost, which is what they are.
  const environment = fromBuildEnvironment('XECRET_ENV');
  if (environment !== undefined && environment !== 'development') {
    throw new Error(
      `XECRET_PUBLIC_URL is not set, but XECRET_ENV is "${environment}". Canonical URLs, ` +
        'sitemap.xml, robots.txt and the JSON-LD @id are all decided during `next build`, so ' +
        "a build that cannot name its own origin would publish somebody else's. Deploy with " +
        '`scripts/deploy-web.sh <env>`, which reads the origin out of apps/web/wrangler.jsonc, ' +
        'or set XECRET_PUBLIC_URL in the build environment yourself.',
    );
  }

  return LOCAL_ORIGIN;
}

/** The origin the published documentation is served from. No trailing slash. */
export const SITE_ORIGIN = buildOrigin();

/**
 * The same deployment as a bare hostname, with a port only if the origin had
 * one — `xecret.playxoft.com`, not `https://xecret.playxoft.com/`.
 *
 * A few formats ask for a host rather than a URL, and `robots.txt`'s `Host`
 * directive is the one this application writes. Its grammar admits a hostname
 * and an optional port and nothing else, and a crawler that reads a scheme or
 * a trailing slash there does not complain — it drops the line. That is the
 * worst possible failure for a directive whose entire job is to name the
 * canonical host while the deployment is moving between two of them.
 */
export const SITE_HOST = new URL(SITE_ORIGIN).host;

/** An absolute URL for a site-relative path, for canonicals and structured data. */
export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

export const SITE_NAME = 'xecret';

export const SITE_TAGLINE = 'Open-source secret management for developers';

/**
 * Terms that describe what this product *is*, used as the base keyword set for
 * every documentation page. Per-page keywords from frontmatter are appended,
 * never substituted — a page about the CLI is still a page about secret
 * management.
 */
export const SITE_KEYWORDS = [
  'secret management',
  'environment variables',
  'env file alternative',
  'secrets manager',
  'developer tools',
  'open source',
] as const;
