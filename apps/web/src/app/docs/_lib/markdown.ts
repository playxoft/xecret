import { Marked, type Token, type Tokens } from 'marked';

import { SITE_ORIGIN } from '@/lib/site';
import { escapeHtml, highlight, languageLabel } from './highlight';

/**
 * Markdown → HTML for the published documentation.
 *
 * The `.md` files under `public/docs/` are the single source of truth: this
 * module renders them for people, the same files are served verbatim for
 * machines (see `app/llms.txt`), and nothing is written twice. That is the
 * whole reason the content is markdown rather than JSX.
 *
 * Six renderer overrides do all the work:
 *
 *  - **headings** gain stable ids and a hover anchor, and register themselves
 *    in the table of contents as they are rendered — one pass, so the contents
 *    list and the page can never disagree about a slug.
 *  - **code fences** become a labelled block with a copy button.
 *  - **links** written as relative `.md` paths — which is what makes the raw
 *    files navigable in an editor — are rewritten to site routes, and only
 *    `http`, `https` and `mailto` are allowed to leave the site at all.
 *  - **images** are resolved the same way, and only ever load from this origin.
 *  - **raw HTML** is escaped rather than passed through.
 *  - **blockquotes** opening with `**Note**`, `**Tip**`, `**Warning**` or
 *    `**Important**` become callouts.
 *
 * The last two exist because of where this output goes. `DocBody` hands it to
 * `dangerouslySetInnerHTML` and every page is prerendered, so a `<script>` that
 * survives this module is a `<script>` in the static HTML file, executed while
 * the document is being parsed. The application does now send a
 * Content-Security-Policy, and it does not catch this: `script-src` has to
 * carry `'unsafe-inline'` for the RSC flight payload, so an inline script in
 * the prerendered document runs regardless. `lib/csp.ts` says why at length.
 * What the policy limits is what such a script can then reach; what it never
 * does is excuse this module from escaping.
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
 * Case is folded, because `HTTPS:` is a scheme somebody writes. Nothing else
 * is normalised, and nothing else should be, because the caller matches this
 * against an allowlist rather than against a list of dangerous schemes:
 * whatever residue an obfuscation leaves behind — a stray tab from markdown's
 * angle-bracket link form, an undecoded `&#106;` — is simply not equal to
 * `http`, `https` or `mailto`, and the link is refused.
 *
 * An earlier version stripped whitespace here, reasoning that a browser strips
 * it too. It does, but the conclusion runs backwards: against a positive
 * allowlist, normalising an obfuscation can only ever turn a refusal into an
 * acceptance. `java<tab>script:` was refused either way, while `htt<tab>ps:`
 * was refused without the stripping and allowed with it.
 */
function schemeOf(href: string): string | null {
  return /^([^:/?#]+):/.exec(href)?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether a schemeless href really does stay on this origin.
 *
 * Asked of the URL parser rather than of the string, because the string does
 * not know the answer. `URL` strips every ASCII tab, line feed and carriage
 * return before it parses — the standard requires it and every browser does it
 * — so `/<tab>/evil.example` reassembles into a scheme-relative URL and departs
 * for `evil.example`, *after* a `startsWith('/')` guard has read it as a path
 * on this site. A backslash is folded into a slash for the same reason. Writing
 * another regular expression against those two shapes is guessing at which
 * spelling comes next; resolving the href is the question itself.
 *
 * `SITE_ORIGIN` is the base rather than the page's own URL because the answer
 * is identical either way — a reference beginning with `/` ignores the base's
 * path, and one beginning with `//` ignores everything but its scheme — and
 * this renderer should not have to know which page it is rendering in order to
 * know whether a link leaves the site.
 */
function staysOnSite(href: string): boolean {
  try {
    return new URL(href, SITE_ORIGIN).origin === SITE_ORIGIN;
  } catch {
    // `new URL` throws on a host it cannot parse at all — an unclosed IPv6
    // literal is the usual one. Unparseable is not the same as harmless.
    return false;
  }
}

/**
 * A relative path joined onto the directory the linking document sits in.
 *
 * Shared by links and images because both mean the same thing by `./` and
 * `../`: the position on disk, so a path resolves identically in an editor and
 * in the browser. Returns the joined path with no leading slash.
 */
function resolveRelative(path: string, fromSlug: string): string {
  const fromSegments = fromSlug ? fromSlug.split('/') : [];
  // Drop the document's own filename: a relative path resolves against the
  // directory it sits in, exactly as it would on disk.
  const base = fromSegments.slice(0, -1);

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }

  return base.join('/');
}

/**
 * `./cli/commands.md` → `/docs/cli/commands`, `../faq.md#pin` → `/docs/faq#pin`.
 *
 * Resolved against the linking document's own slug, so a relative link means
 * the same thing in an editor and in the browser.
 *
 * `null` means the href does not name a destination this renderer is willing
 * to vouch for — an unlisted scheme, or a path that turns out to leave the
 * site. `link()` renders those as plain text: a link losing its anchor is a
 * visible mistake somebody fixes, whereas a destination reaching the page as a
 * live `href` is not visible at all until somebody follows it.
 */
function resolveDocHref(href: string, fromSlug: string): string | null {
  const scheme = schemeOf(href);
  if (scheme !== null) return SAFE_SCHEMES.has(scheme) ? href : null;

  const path = href.startsWith('#') || href.startsWith('/') ? href : docRoute(href, fromSlug);

  // Everything arriving without a scheme is claiming to be somewhere on this
  // site, and that claim is checked by resolving it rather than by reading it.
  // A scheme-relative `//host` is the honest version of the claim and is
  // refused here along with the dishonest ones: the only reason to write one
  // instead of `https://` is a mixed-content problem that stopped existing
  // years ago, and passing it through is what made the "every outbound link
  // gets `noreferrer noopener`" rule below untrue for the one link shape that
  // reads as internal.
  return staysOnSite(path) ? path : null;
}

/** The `/docs` route a relative `.md` path names. */
function docRoute(href: string, fromSlug: string): string {
  const [pathPart = '', hash] = href.split('#');
  const fragment = hash ? `#${hash}` : '';

  const path = resolveRelative(pathPart, fromSlug)
    .replace(/\.md$/, '')
    .replace(/\/index$/, '');
  return path ? `/docs/${path}${fragment}` : `/docs${fragment}`;
}

/**
 * `./diagram.png` → `/docs/cli/diagram.png`, or `null` for a source this
 * renderer will not fetch.
 *
 * An image is not a link, and the difference is the whole of this function.
 * Nobody decides to load one: the browser requests it while the page is still
 * arriving, so an off-site `<img>` hands that host the reader's IP address,
 * user agent and referring URL on every single view, silently, with nothing to
 * click and nothing on the page to notice. That is a tracking pixel whether or
 * not it was meant as one, and this is the documentation for a secret manager.
 *
 * So the allowlist `link()` uses does not apply here: `https:` is refused along
 * with everything else, and the only sources that survive are the ones served
 * from this origin. Nothing under `public/docs` has ever wanted otherwise —
 * every image a document needs ships in this repository beside it, which is
 * also the only way it stays available once somebody else's host is
 * reorganised. If that ever stops being true, the image gets copied in.
 */
function resolveDocSrc(src: string, fromSlug: string): string | null {
  if (schemeOf(src) !== null) return null;

  const path = src.startsWith('/') ? src : `/docs/${resolveRelative(src, fromSlug)}`;
  return staysOnSite(path) ? path : null;
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
  const usedIds = new Set<string>();

  /**
   * A fragment no other heading on this page has taken.
   *
   * Counting occurrences per base slug is not enough, and the document that
   * breaks it is an ordinary one: `## Tokens`, `## Tokens`, `## Tokens 2`
   * slugify to `tokens`, `tokens` and `tokens-2`, so a counter keyed on
   * `tokens` alone hands the second heading the id `tokens-2` — which the
   * third heading, whose text really is "Tokens 2", then claims as well. The
   * page ends up with a duplicate id, a contents entry that jumps to the wrong
   * heading, and a scroll-spy observer that only ever reports the first of the
   * two, none of which looks like the same bug from the outside.
   *
   * So the suffixed candidate is checked against every id already issued, and
   * the suffix keeps moving until one is free. Terminates because each pass
   * either finds a free id or excludes one more of a finite set.
   */
  function uniqueId(base: string): string {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }

    let suffix = 2;
    while (usedIds.has(`${base}-${suffix}`)) suffix += 1;

    const unique = `${base}-${suffix}`;
    usedIds.add(unique);
    return unique;
  }

  const marked = new Marked({
    gfm: true,
    breaks: false,

    /**
     * Undoes marked's "this run of text is already escaped" promise.
     *
     * Inside `<pre>`, `<code>`, `<kbd>` and `<script>`, marked flags the text
     * between the tags as escaped so that raw HTML written around it survives
     * intact. `html()` below has just withdrawn that offer — nothing raw
     * survives — and what the flag now buys is a hole rather than a feature:
     * the inline tokenizer only produces an HTML token for a tag its regular
     * expression recognises, and `<img/src=x onerror=…>` is one it rejects and
     * every browser accepts. Written inside an inline `<pre>` it arrives here
     * as "already escaped" text and reaches the document verbatim.
     *
     * Cleared in a token walk rather than in a `text()` override because the
     * parser re-uses the same flag for a legitimate purpose: block-level text
     * it has *already* rendered is re-wrapped in a synthetic paragraph carrying
     * `escaped: true`, and escaping that would double-escape every loose list
     * item on the site. That token is built after this pass has run, so the two
     * uses stay distinguishable only from here.
     */
    walkTokens(token: Token) {
      if (token.type === 'text' && token.escaped) token.escaped = false;
    },

    renderer: {
      heading(token: Tokens.Heading): string {
        const explicit = EXPLICIT_ID.exec(token.text)?.[1];
        const raw = token.text.replace(EXPLICIT_ID, '');

        // The marker is literal text, so it survives inline parsing unchanged
        // and can be trimmed off the rendered HTML — cheaper and less brittle
        // than re-lexing the cleaned string through marked's internals.
        const text = this.parser.parseInline(token.tokens).replace(EXPLICIT_ID, '');
        const title = plainText(raw);
        // An explicit id is never renamed — a heading pins its fragment
        // precisely so that links to it survive a copy-edit, and a renamed
        // "unique" version of it would break the thing it was written for. It
        // is still recorded, so a *derived* slug that would collide with it
        // moves out of the way instead.
        const id = explicit ?? uniqueId(slugify(raw) || 'section');
        if (explicit) usedIds.add(explicit);
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

      image(token: Tokens.Image): string {
        const src = resolveDocSrc(token.href, slug);

        // Rendered through marked's plain-text renderer, exactly as its own
        // image renderer does: `![**a**](x)` describes the picture as "a", not
        // as `<strong>a</strong>`, because an `alt` holds text and nothing
        // else. Escaped afterwards, because that renderer hands back raw HTML
        // for anything it does not understand.
        const alt = escapeHtml(this.parser.parseInline(token.tokens, this.parser.textRenderer));

        // A refused source keeps its description and loses its picture — the
        // same trade `link()` makes, and exactly what a reader browsing with
        // images turned off sees anyway.
        if (src === null) return alt;

        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`;
      },

      /**
       * Raw HTML written in a document is shown, not run.
       *
       * `marked` removed its `sanitize` option and offers nothing in its place,
       * so without this every tag in a `.md` file is copied into the output
       * verbatim — a `<script>` into the prerendered document, an `onerror=`
       * onto an element that fires it without being clicked. Escaping is the
       * bargain `link()` already strikes: the author's mistake becomes visible
       * on the page rather than becoming behaviour nobody can see.
       *
       * One override covers both paths. marked routes a block of HTML and a tag
       * written mid-sentence to the same method, which is also why a tag inside
       * a table cell, a list item or a blockquote arrives here — those parse
       * their contents as ordinary inline markdown.
       *
       * Code samples never reach it: a fence is a `code` token and backticks
       * are a `codespan`, both escaped by their own renderers, so a document
       * showing what a `<script>` tag looks like still shows it.
       */
      html(token: Tokens.HTML | Tokens.Tag): string {
        // A block of it stands as its own paragraph, so the escaped text keeps
        // the article's typography instead of landing between two blocks with
        // no styling at all; a tag written mid-sentence stays in that sentence.
        return token.block ? `<p>${escapeHtml(token.text.trim())}</p>\n` : escapeHtml(token.text);
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
