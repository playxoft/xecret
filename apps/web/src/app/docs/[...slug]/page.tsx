import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { jsonLd } from '@/lib/json-ld';
import { absoluteUrl, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';
import { DocBody } from '../_components/doc-body';
import { DocPager } from '../_components/doc-pager';
import { InlineTableOfContents, TableOfContents } from '../_components/table-of-contents';
import { loadDoc, loadPager, sectionOf } from '../_lib/content';
import { extractFaq, renderMarkdown } from '../_lib/markdown';
import { DOC_SLUGS, docHref, docRawHref } from '../_lib/nav';

/**
 * Every documentation page, rendered from the markdown under `public/docs`.
 *
 * Prerendered in full, with `dynamicParams = false`: an unlisted path is a 404
 * decided by the router, so nothing here ever runs on the Workers runtime and
 * the filesystem reads below happen only during `next build`.
 */
export const dynamicParams = false;

export function generateStaticParams(): Array<{ slug: string[] }> {
  return DOC_SLUGS.map((slug) => ({ slug: slug.split('/') }));
}

/** The slug as one path, rejecting anything not in the manifest. */
async function resolveSlug(params: Promise<{ slug: string[] }>): Promise<string> {
  const { slug } = await params;
  const joined = slug.join('/');
  if (!DOC_SLUGS.includes(joined)) notFound();
  return joined;
}

export async function generateMetadata(props: PageProps<'/docs/[...slug]'>): Promise<Metadata> {
  const slug = await resolveSlug(props.params);
  const doc = await loadDoc(slug);
  const url = absoluteUrl(docHref(slug));

  // The section name rides in the browser-tab title because a reader with six
  // documentation tabs open is choosing between them on about twenty
  // characters, and "CLI · xecret" beside "API · xecret" is the difference.
  const section = sectionOf(slug);

  return {
    title: doc.title,
    description: doc.description,
    keywords: [...doc.keywords, ...SITE_KEYWORDS],
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      siteName: SITE_NAME,
      title: `${doc.title}${section ? ` — ${section}` : ''}`,
      description: doc.description,
    },
    twitter: {
      card: 'summary',
      title: doc.title,
      description: doc.description,
    },
    robots: { index: true, follow: true },
  };
}

export default async function DocPage(props: PageProps<'/docs/[...slug]'>) {
  const slug = await resolveSlug(props.params);
  const doc = await loadDoc(slug);
  const pager = await loadPager(slug);
  const { html, toc } = renderMarkdown(doc.markdown, slug);

  const section = sectionOf(slug);
  const url = absoluteUrl(docHref(slug));

  // TechArticle rather than Article: this is reference material for developers,
  // and the distinction is one Google's rich-result handling actually reads.
  // The breadcrumb trail is what produces the "xecret › Docs › CLI" line under
  // a search result instead of a raw URL.
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: doc.title,
        description: doc.description,
        keywords: [...doc.keywords, ...SITE_KEYWORDS].join(', '),
        dateModified: doc.updated,
        inLanguage: 'en',
        isPartOf: {
          '@type': 'WebSite',
          name: `${SITE_NAME} documentation`,
          url: absoluteUrl('/docs'),
        },
        publisher: { '@type': 'Organization', name: 'Playxoft', url: 'https://playxoft.com' },
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: absoluteUrl('/') },
          { '@type': 'ListItem', position: 2, name: 'Documentation', item: absoluteUrl('/docs') },
          ...(section ? [{ '@type': 'ListItem', position: 3, name: section }] : []),
          { '@type': 'ListItem', position: section ? 4 : 3, name: doc.title, item: url },
        ],
      },
      // Only pages that declare `schema: faq` in their frontmatter, and only
      // from the answers actually rendered above — structured data that says
      // something the visible page does not is worse than none.
      ...(doc.schema === 'faq'
        ? [
            {
              '@type': 'FAQPage',
              '@id': `${url}#faq`,
              mainEntity: extractFaq(html).map((entry) => ({
                '@type': 'Question',
                name: entry.question,
                acceptedAnswer: { '@type': 'Answer', text: entry.answer },
              })),
            },
          ]
        : []),
    ],
  };

  return (
    <div className="flex w-full items-start justify-center gap-10 px-5 lg:px-8">
      <main id="doc-content" className="w-full max-w-3xl min-w-0 py-10 sm:py-12">
        <script
          type="application/ld+json"
          // `jsonLd` rather than `JSON.stringify`: the answers below come from
          // the rendered page and carry whatever a document says, and a `<`
          // reaching a script element unescaped ends it.
          dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }}
        />

        <nav
          aria-label="Breadcrumb"
          className="text-fg-subtle mb-4 flex items-center gap-2 text-sm"
        >
          <Link href="/docs" className="hover:text-fg rounded-sm">
            Docs
          </Link>
          {section ? (
            <>
              <span aria-hidden="true">/</span>
              <span>{section}</span>
            </>
          ) : null}
        </nav>

        <header className="mb-8">
          <h1 className="text-fg text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            {doc.title}
          </h1>
          <p className="text-fg-muted mt-3 text-base leading-7">{doc.description}</p>
          <p className="text-fg-subtle mt-4 text-xs">
            Updated {doc.updated} ·{' '}
            <a href={docRawHref(slug)} className="hover:text-fg-muted underline underline-offset-2">
              read this page as markdown
            </a>
          </p>
        </header>

        <InlineTableOfContents entries={toc} />

        <DocBody html={html} />

        <DocPager previous={pager.previous} next={pager.next} />
      </main>

      <TableOfContents entries={toc} />
    </div>
  );
}
