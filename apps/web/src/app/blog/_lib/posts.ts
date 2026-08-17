import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cache } from 'react';

import { parseFrontmatter, required } from '@/lib/frontmatter';

/**
 * Loading the blog from disk.
 *
 * The same arrangement as the documentation, and for the same reasons: the
 * markdown under `public/blog` is published twice from one copy — rendered at
 * `/blog/<slug>` for a reader, and served verbatim at `/blog/<slug>.md` by
 * Cloudflare's asset handler for anyone who would rather read the source. Both
 * `fs` calls here run during `next build`, because every route that reaches
 * them is prerendered with `dynamicParams = false`.
 *
 * ── Why there is no manifest ──
 * The documentation has one (`docs/_lib/nav.ts`) because its order is
 * editorial: "install" comes after "quickstart" because that is the order you
 * need them in, and no field in a file can express that. A blog's order is
 * simply reverse-chronological, and that *is* a field in the file. So the
 * directory is the index, sorted on `published`, and adding a post is adding a
 * file. A manifest here would only be a second place to forget.
 */

const CONTENT_ROOT = join(process.cwd(), 'public', 'blog');

export interface PostMeta {
  /** Filename without the extension; the path segment under `/blog`. */
  readonly slug: string;
  readonly title: string;
  /** One or two sentences. The meta description, and the card's summary. */
  readonly description: string;
  /** Search terms specific to this post, appended to the site-wide set. */
  readonly keywords: readonly string[];
  /** ISO date of publication. Decides the order of the index. */
  readonly published: string;
  /** ISO date of the last substantive edit; the publication date if never edited. */
  readonly updated: string;
  readonly author: string;
  /** The author's line under their name — “Founder, Playxoft”. */
  readonly role: string;
  /** The one-word category shown on the card. */
  readonly category: string;
  /** Whole minutes, from the body's word count. See `readingMinutes`. */
  readonly minutes: number;
}

export interface PostSource extends PostMeta {
  /** The post body — everything after the frontmatter block. */
  readonly markdown: string;
}

/**
 * Reading time, at 225 words per minute.
 *
 * Deliberately a rough number rather than a precise one. It exists to answer
 * "have I got time for this before my build finishes", and the honest answer
 * to that is "about eight minutes", never "8.4". Code blocks are counted as
 * prose, which slightly over-estimates the technical posts — reading a shell
 * sample is faster than reading a paragraph — and over-estimating is the
 * forgivable direction to be wrong in.
 */
function readingMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 225));
}

/** Reads one post. Memoised per render pass — the index asks for all of them. */
export const loadPost = cache(async (slug: string): Promise<PostSource> => {
  const source = `blog/${slug}.md`;
  const raw = await readFile(join(CONTENT_ROOT, `${slug}.md`), 'utf8');
  const { data, body } = parseFrontmatter(raw, source);

  const published = required(data, 'published', source);

  return {
    slug,
    title: required(data, 'title', source),
    description: required(data, 'description', source),
    keywords: data.keywords ?? [],
    published,
    // A post that has never been edited was last modified when it was written.
    // Defaulting `updated` to today's build instead would tell every crawler
    // that the entire archive changed on every deploy, which is how a site
    // teaches Google to stop believing its `lastModified` dates.
    updated: data.updated?.[0] ?? published,
    author: data.author?.[0] ?? 'The xecret team',
    role: data.role?.[0] ?? '',
    category: data.category?.[0] ?? 'Engineering',
    minutes: readingMinutes(body),
    markdown: body,
  };
});

/** Every post slug, newest first. */
export const loadSlugs = cache(async (): Promise<readonly string[]> => {
  const files = await readdir(CONTENT_ROOT);
  const slugs = files.filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3));

  const dated = await Promise.all(
    slugs.map(async (slug) => ({ slug, published: (await loadPost(slug)).published })),
  );

  // Compared as strings: the dates are ISO, and ISO dates sort chronologically
  // as text. `new Date()` here would parse each one twice per comparison and
  // buy nothing.
  return dated.sort((a, b) => b.published.localeCompare(a.published)).map((entry) => entry.slug);
});

/**
 * One post's metadata without its body.
 *
 * Written out field by field rather than spread from the loaded post: this
 * metadata is serialised into the HTML of the index and of every post that
 * links to another, and a spread would ship the full markdown of every article
 * to the browser the first time somebody adds a field to `PostSource`.
 */
function toMeta(post: PostSource): PostMeta {
  return {
    slug: post.slug,
    title: post.title,
    description: post.description,
    keywords: post.keywords,
    published: post.published,
    updated: post.updated,
    author: post.author,
    role: post.role,
    category: post.category,
    minutes: post.minutes,
  };
}

/** Every post's metadata, newest first, without any post body. */
export const loadPosts = cache(async (): Promise<readonly PostMeta[]> => {
  const slugs = await loadSlugs();
  return Promise.all(slugs.map(async (slug) => toMeta(await loadPost(slug))));
});

/** The route a post is published at. */
export function postHref(slug: string): string {
  return `/blog/${slug}`;
}

/** The raw markdown, served straight from `public/blog`. */
export function postRawHref(slug: string): string {
  return `/blog/${slug}.md`;
}

/**
 * A date as a reader reads it: `14 July 2026`.
 *
 * `en-GB` explicitly, and `UTC` explicitly. The default locale of a Cloudflare
 * Worker is not the reader's, and a prerendered page has one date for everyone
 * anyway — so it may as well be the same one the sitemap and the structured
 * data publish, rather than whatever the build machine's timezone shifts it to.
 */
export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Up to `count` other posts, for the "keep reading" row at the foot of a post.
 *
 * Same-category posts first, then the newest of whatever is left. It is not a
 * recommendation engine and does not pretend to be: with a dozen posts, "more
 * on this subject, then more that is recent" is what a reader actually wants,
 * and it needs no embeddings, no index and no click data.
 */
export async function relatedPosts(slug: string, count = 3): Promise<readonly PostMeta[]> {
  const posts = await loadPosts();
  const current = posts.find((post) => post.slug === slug);
  const others = posts.filter((post) => post.slug !== slug);

  const sameCategory = others.filter((post) => post.category === current?.category);
  const rest = others.filter((post) => post.category !== current?.category);

  return [...sameCategory, ...rest].slice(0, count);
}
