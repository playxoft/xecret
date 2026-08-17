/**
 * Facts about this deployment that pages need at *render* time.
 *
 * `publicOrigin()` in `server/bindings.ts` answers the same question for a
 * request handler, reading the Cloudflare binding. It cannot serve this need:
 * every page under `/docs` is prerendered, so its canonical URL, its sitemap
 * entry and its JSON-LD are all decided during `next build`, where no binding
 * exists yet.
 *
 * So the value is read from the build environment, with one fallback constant.
 * That constant is the only place in the application that names the host — when
 * the deployment moves to its own domain, this line and the `wrangler.jsonc`
 * vars change together and nothing else does.
 */
const FALLBACK_ORIGIN = 'https://xecret.playxoft.com';

function normaliseOrigin(value: string): string {
  return value.replace(/\/+$/, '');
}

/** The origin the published documentation is served from. No trailing slash. */
export const SITE_ORIGIN = normaliseOrigin(process.env.XECRET_PUBLIC_URL ?? FALLBACK_ORIGIN);

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
