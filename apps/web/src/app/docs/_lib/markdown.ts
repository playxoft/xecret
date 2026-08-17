import { Marked, type Tokens } from 'marked';

import { escapeHtml, highlight, languageLabel } from './highlight';

/**
 * Markdown → HTML for the published documentation.
 *
 * The `.md` files under `public/docs/` are the single source of truth: this
 * module renders them for people, the same files are served verbatim for
 * machines (see `app/llms.txt`), and nothing is written twice. That is the
 * whole reason the content is markdown rather than JSX.
 *
 * Four renderer overrides do all the work:
 *
 *  - **headings** gain stable ids and a hover anchor, and register themselves
 *    in the table of contents as they are rendered — one pass, so the contents
 *    list and the page can never disagree about a slug.
 *  - **code fences** become a labelled block with a copy button.
 *  - **links** written as relative `.md` paths — which is what makes the raw
 *    files navigable in an editor — are rewritten to site routes, and only
 *    `http`, `https` and `mailto` are allowed to leave the site at all.
 *  - **blockquotes** opening with `**Note**`, `**Tip**`, `**Warning**` or
 *    `**Important**` become callouts.
 */

export interface TocEntry {
  readonly id: string;
  readonly title: string;
  readonly depth: 2 | 3;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly toc: readonly TocEntry[];
}

/** Callout kinds a blockquote may open with. */
const CALLOUT_KINDS = ['Note', 'Tip', 'Warning', 'Important'] as const;
type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * `## Heading {#custom-id}` — an explicit fragment, overriding the derived one.
 *
 * Worth supporting because a derived slug changes when the heading is reworded,
 * and a documentation link that rots on a copy-edit is worse than a slightly
 * uglier source file. Headings other pages link to should pin their id.
 */
const EXPLICIT_ID = /\s*\{#([\p{Letter}\p{Number}_-]+)\}\s*$/u;

/**
 * Heading text → URL fragment.
 *
 * Inline markdown is stripped first, so `## The \`--json\` flag` becomes
 * `the-json-flag` rather than carrying backticks into a URL.
 */
function slugify(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Plain text of a heading, for the contents list. */
function plainText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim();
}

/**
 * Schemes an authored link is allowed to use.
 *
 * `javascript:` and `data:` in an `href` are script execution, and escaping the
 * attribute does nothing about it — `escapeHtml` quotes the quotes and hands
 * the scheme through untouched. Every document under `public/docs` is written
 * in this repository and rendered during `next build`, so there is no attacker
 * on this path today; the allowlist is here because this is the renderer that
 * will be pointed at the next collection, and one that is only safe while its
 * input is trusted is one nobody can safely reuse.
 *
 * `mailto:` earns its place because a support address is a link people write.
 * Anything further — `tel:`, `ftp:` — belongs here only when a document that
 * needs it exists, added by whoever writes that document.
 */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/**
 * The scheme of an href as a *browser* would read it, or `null` if it has none.
 *
 * The scheme is the text before the first colon, and only when no `/`, `?` or
 * `#` comes first — past any of those the colon belongs to a path, a query or a
 * fragment, as in `commands.md#run:once`.
 *
 * Whitespace is dropped before the comparison because a browser drops it too:
 * `java<tab>script:` and `javascript:` navigate to exactly the same place, and
 * markdown's angle-bracket link form carries a literal tab through the parser
 * intact, where the bare form would not have parsed as a link at all.
 *
 * Nothing else is normalised, and nothing else needs to be, because the caller
 * matches this against an allowlist rather than against a list of dangerous
 * schemes: whatever residue an obfuscation leaves behind — a stray control
 * character, an undecoded `&#106;` — is simply not equal to `http`, `https` or
 * `mailto`, and the link is refused.
 */
function schemeOf(href: string): string | null {
  const scheme = /^([^:/?#]+):/.exec(href)?.[1];
  return scheme === undefined ? null : scheme.replace(/\s/g, '').toLowerCase();
}

/**
 * `./cli/commands.md` → `/docs/cli/commands`, `../faq.md#pin` → `/docs/faq#pin`.
 *
 * Resolved against the linking document's own slug, so a relative link means
 * the same thing in an editor and in the browser.
 *
 * `null` means the href does not name a destination this renderer is willing
 * to vouch for — an unlisted scheme, or a scheme-relative host. `link()`
 * renders those as plain text: a link losing its anchor is a visible mistake
 * somebody fixes, whereas a destination reaching the page as a live `href` is
 * not visible at all until somebody follows it.
 */
function resolveDocHref(href: string, fromSlug: string): string | null {
  const scheme = schemeOf(href);
  if (scheme !== null) return SAFE_SCHEMES.has(scheme) ? href : null;

  if (href.startsWith('#')) return href;

  // A leading `//` is scheme-relative: it inherits `https` and then leaves for
  // whatever host follows. Refused rather than resolved, because the only
  // reason to write one instead of `https://` is a mixed-content problem that
  // stopped existing years ago — and because passing it through made the
  // "every outbound link gets `noreferrer noopener`" rule below untrue for the
  // one link shape that reads as internal.
  //
  // Browsers treat a backslash in that position as a slash, so `/\evil.com`
  // and `\\evil.com` navigate off-site while `href.startsWith('/')` reads them
  // as a site path. No author writes those by hand; they only appear where
  // somebody is trying to get a same-origin check to say yes.
  if (/^[/\\][/\\]/.test(href)) return null;
  if (href.startsWith('/')) return href;

  const [pathPart = '', hash] = href.split('#');
  const fragment = hash ? `#${hash}` : '';

  const fromSegments = fromSlug ? fromSlug.split('/') : [];
  // Drop the document's own filename: a relative link resolves against the
  // directory it sits in, exactly as it would on disk.
  const base = fromSegments.slice(0, -1);

  for (const segment of pathPart.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }

  const path = base
    .join('/')
    .replace(/\.md$/, '')
    .replace(/\/index$/, '');
  return path ? `/docs/${path}${fragment}` : `/docs${fragment}`;
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
  '<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m5 13 4 4L19 7"/></svg>';

const ANCHOR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

/**
 * Turns one document's markdown into HTML and its contents list.
 *
 * `slug` is the document's own path under `/docs`, used only to resolve
 * relative links.
 */
export function renderMarkdown(source: string, slug: string): RenderedMarkdown {
  const toc: TocEntry[] = [];
  const usedIds = new Map<string, number>();

  function uniqueId(base: string): string {
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  }

  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading(token: Tokens.Heading): string {
        const explicit = EXPLICIT_ID.exec(token.text)?.[1];
        const raw = token.text.replace(EXPLICIT_ID, '');

        // The marker is literal text, so it survives inline parsing unchanged
        // and can be trimmed off the rendered HTML — cheaper and less brittle
        // than re-lexing the cleaned string through marked's internals.
        const text = this.parser.parseInline(token.tokens).replace(EXPLICIT_ID, '');
        const title = plainText(raw);
        const id = explicit ?? uniqueId(slugify(raw) || 'section');
        const depth = token.depth;

        if (depth === 2 || depth === 3) toc.push({ id, title, depth });

        // The anchor sits *inside* the heading so screen-reader users reach it
        // in document order, and is labelled with the heading's own text
        // rather than "link", which is what a link list full of "link" costs.
        return (
          `<h${depth} id="${id}" class="doc-heading doc-h${depth}">` +
          `<a class="doc-anchor" href="#${id}" aria-label="Link to “${escapeHtml(title)}”">${ANCHOR_ICON}</a>` +
          `${text}</h${depth}>\n`
        );
      },

      code(token: Tokens.Code): string {
        const label = languageLabel(token.lang);
        const body = highlight(token.text, token.lang);

        return (
          '<figure class="doc-code">' +
          '<div class="doc-code-bar">' +
          (label ? `<span class="doc-code-lang">${escapeHtml(label)}</span>` : '<span></span>') +
          '<button type="button" class="doc-copy" data-copy aria-label="Copy code to clipboard">' +
          `<span class="doc-copy-idle">${COPY_ICON}</span>` +
          `<span class="doc-copy-done">${CHECK_ICON}</span>` +
          '</button>' +
          '</div>' +
          `<pre><code>${body}</code></pre>` +
          '</figure>\n'
        );
      },

      link(token: Tokens.Link): string {
        const href = resolveDocHref(token.href, slug);
        const text = this.parser.parseInline(token.tokens);

        // A refused scheme keeps its words and loses its anchor. The sentence
        // still reads, and the page cannot navigate anywhere this renderer was
        // unwilling to vouch for.
        if (href === null) return text;

        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        // Asked of the same helper that vetted the scheme, so "safe" and
        // "outbound" can never disagree about what the scheme actually is.
        const scheme = schemeOf(href);
        const external = scheme === 'http' || scheme === 'https';

        // `noreferrer noopener` on every outbound link: a documentation page is
        // linked from a security product, and `window.opener` is a real hole.
        const rel = external ? ' target="_blank" rel="noreferrer noopener"' : '';
        const marker = external ? '<span class="doc-external" aria-hidden="true">↗</span>' : '';

        return `<a href="${escapeHtml(href)}"${title}${rel}>${text}${marker}</a>`;
      },

      table(token: Tokens.Table): string {
        // Reference tables are wide by nature and a documentation page must
        // never scroll sideways as a whole, so each table gets its own
        // scroll container. `tabindex` makes that container keyboard
        // reachable, which WCAG 2.1 SC 2.1.1 requires of any scrollable region.
        const head = token.header
          .map(
            (cell, index) =>
              `<th${alignAttr(token.align[index])}>${this.parser.parseInline(cell.tokens)}</th>`,
          )
          .join('');

        const body = token.rows
          .map(
            (row) =>
              '<tr>' +
              row
                .map(
                  (cell, index) =>
                    `<td${alignAttr(token.align[index])}>${this.parser.parseInline(cell.tokens)}</td>`,
                )
                .join('') +
              '</tr>',
          )
          .join('');

        return (
          '<div class="doc-table-wrap" tabindex="0" role="region" aria-label="Table">' +
          `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
          '</div>\n'
        );
      },

      blockquote(token: Tokens.Blockquote): string {
        const inner = this.parser.parse(token.tokens);
        const kind = calloutKind(inner);
        if (!kind) return `<blockquote class="doc-quote">${inner}</blockquote>\n`;

        const stripped = inner.replace(CALLOUT_OPENER, '<p>');
        return (
          `<aside class="doc-callout doc-callout-${kind.toLowerCase()}">` +
          `<p class="doc-callout-label">${kind}</p>` +
          `<div class="doc-callout-body">${stripped}</div>` +
          '</aside>\n'
        );
      },
    },
  });

  const html = marked.parse(source, { async: false });
  return { html, toc };
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

/**
 * Question-and-answer pairs from rendered HTML, for `FAQPage` structured data.
 *
 * Each `<h3>` is a question and everything up to the next heading is its
 * answer. Reading the rendered output rather than the markdown means the answer
 * text is exactly what the page displays — structured data that disagrees with
 * the visible page is the one thing search engines penalise it for.
 *
 * Tags are stripped: schema.org wants the answer as text, and entity-decoding a
 * handful of named entities is the whole of what that requires here, because
 * the renderer only ever emits the five it escapes.
 */
export function extractFaq(html: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const sections = html.split(/(?=<h[23] )/);

  for (const [index, section] of sections.entries()) {
    const question = /^<h3[^>]*>([\s\S]*?)<\/h3>/.exec(section);
    if (!question) continue;

    // Everything after the closing </h3>, up to the next heading — which is
    // where the next array element begins, so it is simply the rest.
    const body = section.slice(question[0].length);
    const answer = stripTags(body);
    if (answer === '') continue;

    entries.push({ question: stripTags(question[1] ?? `Question ${index}`), answer });
  }

  return entries;
}

function stripTags(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const CALLOUT_OPENER = new RegExp(
  `^<p><strong>(${CALLOUT_KINDS.join('|')})</strong>\\s*(?:&mdash;|—|:|-)?\\s*`,
);

function calloutKind(html: string): CalloutKind | null {
  const found = CALLOUT_OPENER.exec(html)?.[1];
  return CALLOUT_KINDS.find((kind) => kind === found) ?? null;
}

function alignAttr(align: 'center' | 'left' | 'right' | null | undefined): string {
  return align ? ` style="text-align:${align}"` : '';
}
