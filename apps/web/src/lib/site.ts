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
