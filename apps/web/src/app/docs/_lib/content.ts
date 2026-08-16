import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cache } from 'react';

import { DOC_SLUGS, DOCS_SECTIONS, docHref } from './nav';

/**
 * Loading the documentation from disk.
 *
 * ── Why the markdown lives in `public/` ───────────────────────────────────
 * Because it is published twice, from one copy. `/docs/cli/commands` is the
 * rendered page a person reads; `/docs/cli/commands.md` is the same file served
 * verbatim by Cloudflare's asset handler, which is what an AI agent, a `curl`,
 * or anyone auditing what the page claims should be able to fetch. Keeping the
 * source anywhere else would mean either a second copy that drifts or a route
 * handler that re-reads and re-serves what the CDN already has.
 *
 * ── Why `fs` is safe here ─────────────────────────────────────────────────
 * Every reader is a prerendered page or a statically generated route handler,
 * so all of this runs during `next build`. Nothing on the Workers runtime ever
 * calls it: `dynamicParams = false` on the `[...slug]` route means an unlisted
 * path is a 404 from the router, not a filesystem lookup at the edge.
 */

const CONTENT_ROOT = join(process.cwd(), 'public', 'docs');

export interface DocMeta {
  /** Path under `/docs`, e.g. `cli/commands`. */
  readonly slug: string;
  /** Page title: the `<h1>`, the `<title>`, and the sitemap entry. */
  readonly title: string;
  /** Shorter label for the sidebar, where the full title would wrap. */
  readonly navTitle: string;
  /** One sentence. Used as the meta description and the sidebar tooltip. */
  readonly description: string;
  /** Search terms specific to this page, appended to the site-wide set. */
  readonly keywords: readonly string[];
  /** ISO date of the last substantive edit, for `lastModified` in the sitemap. */
  readonly updated: string;
  /**
   * An extra structured-data shape for this page, beyond the `TechArticle`
   * every documentation page emits. `faq` publishes each `###` heading and the
   * prose beneath it as a question and answer.
   */
  readonly schema: 'faq' | null;
}

export interface DocSource extends DocMeta {
  /** The document body — everything after the frontmatter block. */
  readonly markdown: string;
}

/**
 * Splits `---`-delimited frontmatter from the body.
 *
 * A deliberately small parser rather than a YAML dependency: the fields are
 * fixed, the files are ours, and the shapes it accepts are `key: value` and
 * `key: [a, b, c]`. Anything else in a frontmatter block is a mistake that
 * should be noticed, so it throws rather than guessing.
 */
function parseFrontmatter(
  raw: string,
  slug: string,
): { data: Record<string, string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    throw new Error(`docs/${slug}.md has no frontmatter block.`);
  }

  const data: Record<string, string[]> = {};

  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`docs/${slug}.md frontmatter line is not "key: value": ${line}`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    data[key] = value.startsWith('[')
      ? value
          .slice(1, value.endsWith(']') ? -1 : undefined)
          .split(',')
          .map(unquote)
          .filter((entry) => entry !== '')
      : [unquote(value)];
  }

  return { data, body: raw.slice(match[0].length) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function required(data: Record<string, string[]>, key: string, slug: string): string {
  const value = data[key]?.[0];
  if (!value) throw new Error(`docs/${slug}.md is missing frontmatter "${key}".`);
  return value;
}

/**
 * Reads one document. Memoised per render pass, because the sidebar asks for
 * every document's metadata on every page.
 */
export const loadDoc = cache(async (slug: string): Promise<DocSource> => {
  const raw = await readFile(join(CONTENT_ROOT, `${slug}.md`), 'utf8');
  const { data, body } = parseFrontmatter(raw, slug);

  const title = required(data, 'title', slug);

  return {
    slug,
    title,
    navTitle: data.navTitle?.[0] ?? title,
    description: required(data, 'description', slug),
    keywords: data.keywords ?? [],
    updated: required(data, 'updated', slug),
    schema: data.schema?.[0] === 'faq' ? 'faq' : null,
    markdown: body,
  };
});

export interface NavItem extends DocMeta {
  readonly href: string;
}

export interface NavSection {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly NavItem[];
}

/**
 * A document's metadata without its body.
 *
 * Written out field by field rather than spread from the loaded document: the
 * navigation is serialised into the HTML of every page, and a spread would ship
 * the entire markdown of all twenty-five documents to the browser the first
 * time somebody adds a field to `DocSource`.
 */
function toNavItem(doc: DocSource): NavItem {
  return {
    slug: doc.slug,
    title: doc.title,
    navTitle: doc.navTitle,
    description: doc.description,
    keywords: doc.keywords,
    updated: doc.updated,
    schema: doc.schema,
    href: docHref(doc.slug),
  };
}

/** The sidebar and the contents page, assembled from the ordering plus frontmatter. */
export const loadNav = cache(async (): Promise<readonly NavSection[]> => {
  return Promise.all(
    DOCS_SECTIONS.map(async (section) => ({
      title: section.title,
      summary: section.summary,
      items: await Promise.all(section.slugs.map(async (slug) => toNavItem(await loadDoc(slug)))),
    })),
  );
});

export interface Pager {
  readonly previous: NavItem | null;
  readonly next: NavItem | null;
}

/** The pages either side of this one in reading order. */
export const loadPager = cache(async (slug: string): Promise<Pager> => {
  const index = DOC_SLUGS.indexOf(slug);
  const at = async (position: number): Promise<NavItem | null> => {
    const target = DOC_SLUGS[position];
    if (index === -1 || !target) return null;
    return toNavItem(await loadDoc(target));
  };

  const [previous, next] = await Promise.all([at(index - 1), at(index + 1)]);
  return { previous, next };
});

/** Which section a slug belongs to, for the breadcrumb and the JSON-LD trail. */
export function sectionOf(slug: string): string | null {
  return DOCS_SECTIONS.find((section) => section.slugs.includes(slug))?.title ?? null;
}
