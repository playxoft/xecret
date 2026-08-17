import type { MetadataRoute } from 'next';

import { loadPosts, postHref } from './blog/_lib/posts';
import { loadDoc } from './docs/_lib/content';
import { DOC_SLUGS, docHref } from './docs/_lib/nav';
import { absoluteUrl } from '@/lib/site';

/**
 * The sitemap, covering the public surface only.
 *
 * Nothing under `/app` appears: those routes sit behind a session and would
 * offer a crawler a list of redirects. Nothing under `/api` appears either.
 * What is left is the marketing pages, the blog and the documentation — which is
 * the whole point of publishing them at a URL rather than in a repository.
 *
 * `lastModified` comes from each document's own `updated` frontmatter rather
 * than from the build clock. A sitemap that claims every page changed on every
 * deploy teaches crawlers to ignore the field. The handful of hand-written
 * pages below carry a date for the same reason — edit the page, edit the date.
 *
 * ── On priority ──
 * Priority is a relative statement about this site, not a ranking factor. What
 * it is actually for is crawl budget: it tells a crawler which twenty of a
 * hundred URLs to revisit first. So the pages that convert or that answer a
 * search directly sit at the top, and the legal pages — which must be indexed,
 * and which nobody searches for — sit at the bottom.
 */

/** Pages written as components rather than markdown. */
const STATIC_PAGES = [
  { path: '/', lastModified: '2026-08-16', changeFrequency: 'weekly', priority: 1 },
  { path: '/features', lastModified: '2026-08-16', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/pricing', lastModified: '2026-08-16', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/docs', lastModified: '2026-08-16', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/blog', lastModified: '2026-08-16', changeFrequency: 'daily', priority: 0.8 },
  { path: '/faq', lastModified: '2026-08-16', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/about', lastModified: '2026-08-16', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/privacy', lastModified: '2026-08-16', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', lastModified: '2026-08-16', changeFrequency: 'yearly', priority: 0.3 },
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await Promise.all(
    DOC_SLUGS.map(async (slug) => {
      const { updated } = await loadDoc(slug);
      return {
        url: absoluteUrl(docHref(slug)),
        lastModified: new Date(updated),
        changeFrequency: 'monthly' as const,
        // The quickstart and the CLI reference are the pages worth ranking;
        // the rest of the documentation sits one step below them.
        priority: slug === 'quickstart' || slug === 'cli/commands' ? 0.9 : 0.7,
      };
    }),
  );

  const posts = (await loadPosts()).map((post) => ({
    url: absoluteUrl(postHref(post.slug)),
    lastModified: new Date(post.updated),
    // A published post rarely changes. Saying `monthly` here would have a
    // crawler re-fetch forty unchanged articles for every one that moved.
    changeFrequency: 'yearly' as const,
    priority: 0.6,
  }));

  return [
    ...STATIC_PAGES.map((page) => ({
      url: absoluteUrl(page.path),
      lastModified: new Date(page.lastModified),
      changeFrequency: page.changeFrequency,
      priority: page.priority,
    })),
    ...docs,
    ...posts,
  ];
}
