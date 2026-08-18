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

/**
 * Rejects a configured value that is not an absolute `http(s)` origin, naming
 * the variable while doing it.
 *
 * Without this the check happens by accident, one line further down, at
 * `new URL(SITE_ORIGIN)` — and it happens in two different ways, neither of
 * them useful. `xecret.example.com` throws a bare `Invalid URL` that names no
 * variable and no file, during `next build`, where the reader has no reason to
 * suspect an environment variable at all. `example.com:8080` is worse: `URL`
 * parses it happily as the scheme `example.com:` with the path `8080`, so
 * nothing throws, `SITE_HOST` comes out as the empty string, and `robots.txt`
 * ships a `Host:` line with nothing after it — the silent SEO failure this
 * module was rewritten to stop, arriving through the front door.
 *
 * Checking the protocol rather than just that `URL` accepted the string is what
 * catches the second case, and it is the one somebody actually types.
 */
function requireAbsoluteOrigin(value: string): string {
  const shape = 'It must include the scheme — for example https://xecret.example.com.';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`XECRET_PUBLIC_URL is not a valid URL: "${value}". ${shape}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `XECRET_PUBLIC_URL must be an http or https origin, but "${value}" parses as the scheme ` +
        `"${parsed.protocol}" with no host. ${shape}`,
    );
  }

  return value;
}

function buildOrigin(): string {
  const configured = fromBuildEnvironment('XECRET_PUBLIC_URL');
  if (configured !== undefined) return requireAbsoluteOrigin(normaliseOrigin(configured));

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
        'or set XECRET_PUBLIC_URL in the build environment yourself. If you are not building ' +
        'for a deployment, XECRET_ENV is coming from your shell — a sourced .env, or ' +
        '`phase run -- ...` — and this check runs on import, so it lands as a crash in every ' +
        'file that touches this module. Unset it, or set XECRET_ENV=development, for that ' +
        'command.',
    );
  }

  return LOCAL_ORIGIN;
}

/**
 * The origin the published documentation is served from. No trailing slash.
 *
 * Resolved at module scope, which means a misconfigured build fails on import
 * rather than at the first render. That is deliberate and stays: the whole
 * point is that a deployment build refuses instead of guessing, and a check
 * that runs later runs after some prerendered page has already been given an
 * origin. The cost is the one the error message above now spells out — a
 * stray `XECRET_ENV` in a developer's shell crashes `vitest` on import instead
 * of failing one test — and the message is the fix for that, not laziness.
 */
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

/** The repository. Linked from the header, the footer and half the copy. */
export const REPO_URL = 'https://github.com/playxoft/xecret';

/** The company behind xecret, named in every `publisher` field below. */
export const PUBLISHER = { name: 'Playxoft', url: 'https://playxoft.com' } as const;

/**
 * The primary navigation, in one place.
 *
 * The header renders it, the footer's product column renders it, and the
 * sitemap prices it. Three copies of a nav is how a site ends up with a page
 * that exists but that nothing links to.
 */
export const SITE_NAV = [
  { href: '/features', label: 'Features', key: 'features' },
  { href: '/pricing', label: 'Pricing', key: 'pricing' },
  { href: '/docs', label: 'Docs', key: 'docs' },
  { href: '/blog', label: 'Blog', key: 'blog' },
  { href: '/about', label: 'About', key: 'about' },
] as const;

/** Which nav entry a page marks as current. */
export type NavKey = (typeof SITE_NAV)[number]['key'];

/**
 * `Organization` and `WebSite`, emitted once from the root layout.
 *
 * Every other page's structured data references these by `@id` rather than
 * repeating them: a knowledge panel is assembled from one organisation that
 * many pages agree on, not from forty organisations that happen to share a
 * name.
 */
export function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': absoluteUrl('/#organization'),
        name: SITE_NAME,
        url: absoluteUrl('/'),
        logo: absoluteUrl('/icon.svg'),
        description: SITE_TAGLINE,
        parentOrganization: { '@type': 'Organization', name: PUBLISHER.name, url: PUBLISHER.url },
        sameAs: [REPO_URL, PUBLISHER.url],
      },
      {
        '@type': 'WebSite',
        '@id': absoluteUrl('/#website'),
        name: SITE_NAME,
        url: absoluteUrl('/'),
        description: SITE_TAGLINE,
        inLanguage: 'en',
        publisher: { '@id': absoluteUrl('/#organization') },
      },
    ],
  };
}

/**
 * The `SoftwareApplication` shape, for pages that describe the product itself.
 *
 * Kept beside the organisation because the two are read together, and because
 * the free tier stated here has to match the pricing page — a rich result that
 * advertises a price the page does not show is a manual action waiting to
 * happen.
 */
export function softwareApplicationSchema() {
  return {
    '@type': 'SoftwareApplication',
    '@id': absoluteUrl('/#software'),
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows, Web',
    description: SITE_TAGLINE,
    url: absoluteUrl('/'),
    publisher: { '@id': absoluteUrl('/#organization') },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free for individuals and small teams. Self-hosting is free for everyone.',
    },
  };
}

/**
 * A `BreadcrumbList` for a top-level public page.
 *
 * This is what turns a raw URL in a search result into “xecret › Pricing”.
 */
export function breadcrumbSchema(trail: ReadonlyArray<{ name: string; path: string }>) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: SITE_NAME, item: absoluteUrl('/') },
      ...trail.map((step, index) => ({
        '@type': 'ListItem',
        position: index + 2,
        name: step.name,
        item: absoluteUrl(step.path),
      })),
    ],
  };
}
