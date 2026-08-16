import type { MetadataRoute } from 'next';

import { loadDoc } from './docs/_lib/content';
import { DOC_SLUGS, docHref } from './docs/_lib/nav';
import { absoluteUrl } from '@/lib/site';

/**
 * The sitemap, covering the public surface only.
 *
 * Nothing under `/app` appears: those routes sit behind a session and would
 * offer a crawler a list of redirects. Nothing under `/api` appears either.
 * What is left is the marketing page and the documentation — which is the whole
 * point of publishing documentation at a URL rather than in a repository.
 *
 * `lastModified` comes from each document's own `updated` frontmatter rather
 * than from the build clock. A sitemap that claims every page changed on every
 * deploy teaches crawlers to ignore the field.
 */
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

  return [
    {
      url: absoluteUrl('/'),
      lastModified: new Date('2026-08-16'),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: absoluteUrl('/docs'),
      lastModified: new Date('2026-08-16'),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    ...docs,
  ];
}
