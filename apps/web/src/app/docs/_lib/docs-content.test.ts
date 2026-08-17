import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { escapeHtml, highlight } from './highlight';
import { renderMarkdown } from './markdown';
import { DOC_SLUGS, DOCS_SECTIONS } from './nav';

/**
 * The documentation's own tests.
 *
 * Published documentation is a product surface, and it fails the way products
 * fail: a page nobody linked, a link nobody followed, a heading anchor that
 * stopped existing when somebody reworded a title. None of that is caught by
 * reading the diff, and all of it is caught here.
 *
 * These run against the real files in `public/docs`, not fixtures.
 */

/**
 * Resolved from this file rather than from `process.cwd()`.
 *
 * `content.ts` uses the working directory because that is what Next guarantees
 * during `next build`. A test should not inherit that assumption: run from the
 * repository root instead of from `apps/web` and every assertion below would
 * fail on a missing directory, which reads as "the documentation is broken"
 * rather than "you are standing somewhere else".
 */
const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'public', 'docs');

async function markdownFiles(dir = CONTENT_ROOT, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await markdownFiles(join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith('.md')) {
      found.push(`${prefix}${entry.name.replace(/\.md$/, '')}`);
    }
  }

  return found;
}

interface LoadedDoc {
  slug: string;
  frontmatter: string;
  body: string;
}

async function loadAll(): Promise<LoadedDoc[]> {
  return Promise.all(
    DOC_SLUGS.map(async (slug) => {
      const raw = await readFile(join(CONTENT_ROOT, `${slug}.md`), 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      return {
        slug,
        frontmatter: match?.[1] ?? '',
        body: match ? raw.slice(match[0].length) : raw,
      };
    }),
  );
}

describe('the manifest and the files agree', () => {
  it('lists every markdown file exactly once', async () => {
    const onDisk = (await markdownFiles()).sort();
    expect([...DOC_SLUGS].sort()).toEqual(onDisk);
  });

  it('lists no slug twice', () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
  });

  it('gives every section at least one page', () => {
    for (const section of DOCS_SECTIONS) {
      expect(section.slugs.length, `${section.title} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('frontmatter', () => {
  it('states a title, a description, keywords and a date on every page', async () => {
    for (const doc of await loadAll()) {
      for (const key of ['title', 'description', 'keywords', 'updated']) {
        expect(doc.frontmatter, `${doc.slug} is missing "${key}"`).toMatch(
          new RegExp(`^${key}:\\s*\\S`, 'm'),
        );
      }
    }
  });

  it('keeps meta descriptions inside the length a search result shows', async () => {
    for (const doc of await loadAll()) {
      const description = /^description:\s*(.+)$/m.exec(doc.frontmatter)?.[1] ?? '';
      // Google truncates around 155–160 characters. Over that is not an error
      // in itself, but it means the tail of the sentence is decoration rather
      // than something a searcher reads; 200 is where it stops being a summary.
      expect(
        description.length,
        `${doc.slug} description is ${description.length} chars`,
      ).toBeLessThanOrEqual(200);
      expect(
        description.length,
        `${doc.slug} description is too short to be useful`,
      ).toBeGreaterThan(40);
    }
  });

  it('never repeats a title between pages', async () => {
    const titles = (await loadAll()).map((doc) => /^title:\s*(.+)$/m.exec(doc.frontmatter)?.[1]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('starts every body below the frontmatter title, never with its own h1', async () => {
    // The page's `<h1>` is rendered from frontmatter. A second one in the body
    // is two competing top-level headings, which is both an outline bug and an
    // SEO one.
    //
    // Checked against the rendered HTML rather than against `^# ` in the
    // source: shell and YAML comments inside fenced blocks start with `# ` too,
    // and a test that cannot tell a comment from a heading is a test that gets
    // disabled.
    for (const doc of await loadAll()) {
      const { html } = renderMarkdown(doc.body, doc.slug);
      expect(html, `${doc.slug} contains an h1`).not.toContain('<h1');
    }
  });
});

describe('links resolve', () => {
  it('points every internal link at a page that exists', async () => {
    const docs = await loadAll();
    const anchors = new Map<string, Set<string>>();

    for (const doc of docs) {
      anchors.set(doc.slug, new Set(renderMarkdown(doc.body, doc.slug).toc.map((e) => e.id)));
    }

    // Explicit `{#id}` anchors do not appear in the h2/h3 contents list when
    // they sit on a heading of another depth, so collect them separately.
    for (const doc of docs) {
      for (const match of doc.body.matchAll(/\{#([\w-]+)\}/g)) {
        anchors.get(doc.slug)?.add(match[1] as string);
      }
    }

    const broken: string[] = [];

    for (const doc of docs) {
      const { html } = renderMarkdown(doc.body, doc.slug);

      for (const match of html.matchAll(/<a href="(\/docs[^"#]*)(#[^"]*)?"/g)) {
        const target = (match[1] as string).replace(/^\/docs\/?/, '');
        if (target !== '' && !DOC_SLUGS.includes(target)) {
          broken.push(`${doc.slug} → ${match[1]} (no such page)`);
          continue;
        }

        const fragment = match[2]?.slice(1);
        if (fragment && target !== '' && !anchors.get(target)?.has(fragment)) {
          broken.push(`${doc.slug} → ${match[1]}#${fragment} (no such heading)`);
        }
      }

      // Same-page anchors.
      for (const match of html.matchAll(/<a href="#([^"]+)"/g)) {
        const fragment = match[1] as string;
        if (!anchors.get(doc.slug)?.has(fragment)) {
          broken.push(`${doc.slug} → #${fragment} (no such heading on this page)`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('leaves no raw .md path in the rendered output', async () => {
    for (const doc of await loadAll()) {
      const { html } = renderMarkdown(doc.body, doc.slug);
      // A `.md` inside an href means a relative link the rewriter did not
      // recognise — it would 404 for a reader while working fine in an editor.
      expect(html, `${doc.slug} has an unrewritten .md link`).not.toMatch(/href="[^"]*\.md"/);
    }
  });
});

describe('rendering', () => {
  it('gives every page a contents list', async () => {
    for (const doc of await loadAll()) {
      const { toc } = renderMarkdown(doc.body, doc.slug);
      expect(toc.length, `${doc.slug} has fewer than two sections`).toBeGreaterThanOrEqual(2);
    }
  });

  it('never emits a duplicate heading id', async () => {
    for (const doc of await loadAll()) {
      const { html } = renderMarkdown(doc.body, doc.slug);
      const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size, `${doc.slug} has a duplicate heading id`).toBe(ids.length);
    }
  });

  it('knows every fence language the documentation actually uses', async () => {
    // A fence whose language has no rule set renders as plain text, which looks
    // like a styling bug rather than a missing entry in `ALIASES`. `text` is
    // the deliberate opt-out for directory trees and terminal transcripts.
    const unknown = new Set<string>();

    for (const doc of await loadAll()) {
      for (const match of doc.body.matchAll(/^```([a-zA-Z][\w+-]*)/gm)) {
        const lang = match[1] as string;
        if (['text', 'txt'].includes(lang)) continue;
        // `highlight` returns the input escaped and unchanged when it has no
        // rules, so a sample containing a comment is the cheapest probe.
        if (highlight('# x\n"y"', lang) === escapeHtml('# x\n"y"')) unknown.add(lang);
      }
    }

    expect([...unknown]).toEqual([]);
  });

  it('rewrites relative links against the linking document’s directory', () => {
    const { html } = renderMarkdown('[a](../faq.md) [b](commands.md) [c](/docs/api)', 'cli/x');
    expect(html).toContain('href="/docs/faq"');
    expect(html).toContain('href="/docs/cli/commands"');
    expect(html).toContain('href="/docs/api"');
  });

  it('honours an explicit heading id', () => {
    const { html, toc } = renderMarkdown('## The golden path {#run}', 'x');
    expect(html).toContain('id="run"');
    expect(html).not.toContain('{#run}');
    expect(toc[0]?.title).toBe('The golden path');
  });

  it('starts every callout body as its own sentence', async () => {
    // `> **Warning** — every one of these…` reads fine in the source and wrong
    // on the page, because the label is lifted out into its own element and the
    // body then opens mid-sentence with a lower-case word. Backticks and the
    // product's own lower-case name are legitimate openings.
    const wrong: string[] = [];

    for (const doc of await loadAll()) {
      for (const match of doc.body.matchAll(
        /^> \*\*(?:Note|Tip|Warning|Important)\*\*\s*(?:—|-|:)?\s*(\S+)/gm,
      )) {
        const opener = match[1] as string;
        if (/^[`*[(]/.test(opener) || opener.startsWith('xecret')) continue;
        if (opener[0] !== opener[0]?.toUpperCase()) wrong.push(`${doc.slug}: “${opener}…”`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('turns a marked blockquote into a callout', () => {
    const { html } = renderMarkdown('> **Warning** — do not do that.', 'x');
    expect(html).toContain('doc-callout-warning');
    expect(html).not.toContain('<strong>Warning</strong>');
  });

  it('leaves an unmarked blockquote as a quote', () => {
    const { html } = renderMarkdown('> just a quotation', 'x');
    expect(html).toContain('doc-quote');
  });

  it('opens external links in a new tab without handing over the opener', () => {
    const { html } = renderMarkdown('[x](https://example.com)', 'x');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe('the highlighter cannot emit unescaped markup', () => {
  it('escapes HTML in every supported language', () => {
    const hostile = `<img src=x onerror="alert(1)"> & 'quoted' "double"`;
    const languages = ['bash', 'json', 'yaml', 'ts', 'go', 'env', 'http', 'sql', 'dockerfile'];
    for (const lang of [...languages, undefined]) {
      const out = highlight(hostile, lang);
      expect(out, `${lang} leaked a tag`).not.toMatch(/<(?!\/?span)/);
      expect(out).toContain('&lt;img');
    }
  });

  it('preserves the source text exactly once the spans are removed', () => {
    const source = 'export TOKEN="abc" # a comment\n';
    const stripped = highlight(source, 'bash')
      .replace(/<\/?span[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    expect(stripped).toBe(source);
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
