import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CtaBand, Container, JsonLd, PublicPage, graph } from '@/components/marketing';
import { absoluteUrl, breadcrumbSchema, PUBLISHER, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';
import { DocBody } from '../../docs/_components/doc-body';
import { InlineTableOfContents, TableOfContents } from '../../docs/_components/table-of-contents';
import { renderMarkdown } from '../../docs/_lib/markdown';
import { PostCard } from '../_components/post-card';
import {
  formatDate,
  loadPost,
  loadSlugs,
  postHref,
  postRawHref,
  relatedPosts,
} from '../_lib/posts';

/**
 * One blog post, rendered from the markdown under `public/blog`.
 *
 * Prerendered in full with `dynamicParams = false`, exactly like the
 * documentation: an unlisted slug is a 404 from the router, so the filesystem
 * reads in `_lib/posts.ts` never run on the Workers runtime.
 */
export const dynamicParams = false;

export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  const slugs = await loadSlugs();
  return slugs.map((slug) => ({ slug }));
}

async function resolveSlug(params: Promise<{ slug: string }>): Promise<string> {
  const { slug } = await params;
  const slugs = await loadSlugs();
  if (!slugs.includes(slug)) notFound();
  return slug;
}

export async function generateMetadata(props: PageProps<'/blog/[slug]'>): Promise<Metadata> {
  const slug = await resolveSlug(props.params);
  const post = await loadPost(slug);
  const url = absoluteUrl(postHref(slug));

  return {
    title: post.title,
    description: post.description,
    keywords: [...post.keywords, ...SITE_KEYWORDS],
    authors: [{ name: post.author }],
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      siteName: SITE_NAME,
      title: post.title,
      description: post.description,
      publishedTime: post.published,
      modifiedTime: post.updated,
      authors: [post.author],
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.description },
    robots: { index: true, follow: true },
  };
}

export default async function BlogPostPage(props: PageProps<'/blog/[slug]'>) {
  const slug = await resolveSlug(props.params);
  const post = await loadPost(slug);
  const related = await relatedPosts(slug);

  // `/blog` as the base path, so a relative `./key-rotation.md` link between
  // two posts resolves to `/blog/key-rotation` rather than into the docs.
  const { html, toc } = renderMarkdown(post.markdown, slug, '/blog');

  const url = absoluteUrl(postHref(slug));

  const structuredData = graph(
    {
      '@type': 'BlogPosting',
      '@id': `${url}#post`,
      headline: post.title,
      description: post.description,
      keywords: [...post.keywords, ...SITE_KEYWORDS].join(', '),
      datePublished: post.published,
      dateModified: post.updated,
      // `wordCount` and `timeRequired` are what let a result show "8 min read"
      // rather than nothing. ISO 8601 duration, which is what schema.org asks
      // for and what nearly every implementation gets wrong.
      timeRequired: `PT${post.minutes}M`,
      inLanguage: 'en',
      author: {
        '@type': 'Person',
        name: post.author,
        ...(post.role ? { jobTitle: post.role } : {}),
      },
      publisher: { '@id': absoluteUrl('/#organization') },
      isPartOf: { '@id': absoluteUrl('/blog#blog') },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    },
    breadcrumbSchema([
      { name: 'Blog', path: '/blog' },
      { name: post.title, path: postHref(slug) },
    ]),
  );

  return (
    <PublicPage current="blog">
      <JsonLd data={structuredData} />

      <Container className="flex w-full items-start justify-center gap-10">
        <article className="w-full max-w-3xl min-w-0 py-10 sm:py-14">
          <nav
            aria-label="Breadcrumb"
            className="text-fg-subtle mb-5 flex items-center gap-2 text-sm"
          >
            <Link href="/blog" className="hover:text-fg rounded-sm">
              Blog
            </Link>
            <span aria-hidden="true">/</span>
            <span>{post.category}</span>
          </nav>

          <header className="mb-9">
            <h1 className="text-fg text-3xl leading-[1.12] font-semibold tracking-[-0.025em] text-balance sm:text-[2.75rem]">
              {post.title}
            </h1>
            <p className="text-fg-muted mt-4 text-base leading-8 text-pretty sm:text-[1.0625rem]">
              {post.description}
            </p>

            <div className="border-line-subtle mt-7 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-5 text-sm">
              <span className="text-fg font-medium">{post.author}</span>
              {post.role ? <span className="text-fg-subtle">{post.role}</span> : null}
              <span aria-hidden="true" className="text-fg-subtle">
                ·
              </span>
              <time dateTime={post.published} className="text-fg-muted">
                {formatDate(post.published)}
              </time>
              <span aria-hidden="true" className="text-fg-subtle">
                ·
              </span>
              <span className="text-fg-muted">{post.minutes} min read</span>
            </div>
          </header>

          <InlineTableOfContents entries={toc} />

          <DocBody html={html} />

          <footer className="border-line-subtle mt-14 border-t pt-6">
            <p className="text-fg-subtle text-xs">
              {post.updated !== post.published ? `Updated ${formatDate(post.updated)} · ` : null}
              <a
                href={postRawHref(slug)}
                className="hover:text-fg-muted underline underline-offset-2"
              >
                Read this post as markdown
              </a>
              {' · '}
              Published by {PUBLISHER.name}
            </p>
          </footer>

          {related.length > 0 ? (
            <section aria-labelledby="keep-reading" className="mt-14">
              <h2
                id="keep-reading"
                className="text-fg-subtle text-xs font-semibold tracking-[0.14em] uppercase"
              >
                Keep reading
              </h2>
              <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {related.map((other) => (
                  <PostCard key={other.slug} post={other} />
                ))}
              </div>
            </section>
          ) : null}
        </article>

        <TableOfContents entries={toc} />
      </Container>

      <CtaBand />
    </PublicPage>
  );
}
