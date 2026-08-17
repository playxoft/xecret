import type { Metadata } from 'next';

import {
  CtaBand,
  Container,
  JsonLd,
  PageHero,
  PublicPage,
  RevealGroup,
  graph,
} from '@/components/marketing';
import { absoluteUrl, breadcrumbSchema, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';
import { PostCard } from './_components/post-card';
import { loadPosts, postHref } from './_lib/posts';

const TITLE = 'Blog';
const DESCRIPTION =
  'Practical writing on secret management: environment variables, .env files, key rotation, CI credentials and the audit trail that tells you who read what.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'secrets management blog',
    'devops security',
    'environment variables',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/blog') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/blog'),
    siteName: SITE_NAME,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
  },
};

export default async function BlogIndexPage() {
  const posts = await loadPosts();
  const [featured, ...rest] = posts;

  // A `Blog` with its posts as an `ItemList`. This is the shape that lets a
  // crawler understand the index as a collection rather than as a page that
  // happens to contain a dozen links, and it is what makes the individual
  // `BlogPosting` on each post page resolve to a publication rather than to a
  // stray article.
  const structuredData = graph(
    {
      '@type': 'Blog',
      '@id': absoluteUrl('/blog#blog'),
      name: `${SITE_NAME} blog`,
      description: DESCRIPTION,
      url: absoluteUrl('/blog'),
      inLanguage: 'en',
      publisher: { '@id': absoluteUrl('/#organization') },
      blogPost: posts.map((post) => ({
        '@type': 'BlogPosting',
        '@id': `${absoluteUrl(postHref(post.slug))}#post`,
        headline: post.title,
        description: post.description,
        datePublished: post.published,
        dateModified: post.updated,
        author: { '@type': 'Person', name: post.author },
        url: absoluteUrl(postHref(post.slug)),
      })),
    },
    breadcrumbSchema([{ name: 'Blog', path: '/blog' }]),
  );

  return (
    <PublicPage current="blog">
      <JsonLd data={structuredData} />

      <PageHero
        eyebrow="Writing"
        title="Secrets, environments, and the parts nobody writes down."
        description="Everything we have learned building a secret manager, written for the engineer who has to make the call on a Friday afternoon. No gated PDFs, no lead magnets."
      />

      <Container className="pb-20 sm:pb-24">
        {featured ? (
          <div className="mb-10">
            <PostCard post={featured} featured />
          </div>
        ) : null}

        {rest.length > 0 ? (
          <>
            {/* Centred over a full-width grid. A left-hugging label above a
                grid that fills the measure is the one thing that makes an
                otherwise symmetric page look off-axis. */}
            <h2 className="text-fg-subtle text-center text-xs font-semibold tracking-[0.14em] uppercase">
              More posts
            </h2>
            <RevealGroup className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </RevealGroup>
          </>
        ) : null}
      </Container>

      <CtaBand
        title="Read the docs, or just try it."
        description="Every post here describes something the product does. The quickstart takes about a minute, and the free tier does not ask for a card."
      />
    </PublicPage>
  );
}
