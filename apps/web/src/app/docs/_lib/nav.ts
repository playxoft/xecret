/**
 * The order of the documentation, and nothing else.
 *
 * Titles, descriptions and keywords live in each document's own frontmatter —
 * one fact, one place — so this file lists slugs only. `content.ts` joins the
 * two into the sidebar, the contents page, the sitemap and the previous/next
 * pager, all of which therefore agree by construction.
 *
 * `docs-content.test.ts` fails the build if a `.md` file exists that no section
 * lists, or if a section lists one that does not exist. Adding a page is
 * therefore: write the file, add the slug here.
 */

export interface DocsSection {
  /** Shown as the sidebar group heading. */
  readonly title: string;
  /**
   * One line, shown on the documentation home page beneath the group title.
   * Rendered as plain text, so no markdown — backticks would print as
   * backticks.
   */
  readonly summary: string;
  readonly slugs: readonly string[];
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    title: 'Getting started',
    summary: 'What xecret is, and how to have it running in five minutes.',
    slugs: ['what-is-xecret', 'quickstart', 'concepts', 'install'],
  },
  {
    title: 'The CLI',
    summary: 'The xecret binary: every command, every flag, and how it finds your project.',
    slugs: ['cli', 'cli/commands', 'cli/configuration', 'cli/offline-cache'],
  },
  {
    title: 'Guides',
    summary: 'Wiring xecret into the framework, container or pipeline you already have.',
    slugs: [
      'guides/nextjs',
      'guides/nodejs',
      'guides/react-vite',
      'guides/go',
      'guides/docker',
      'guides/ci',
      'guides/import-export',
      'guides/teams',
    ],
  },
  {
    title: 'HTTP API',
    summary: 'The contract the dashboard, the CLI and CI all speak.',
    slugs: ['api', 'api/reference', 'api/tokens'],
  },
  {
    title: 'Security',
    summary: 'What xecret can and cannot see, stated plainly rather than implied.',
    slugs: ['security/trust-model', 'security/audit-log'],
  },
  {
    title: 'Running it yourself',
    summary: 'Self-hosting: the honest dependency list and the deployment walk-through.',
    slugs: ['self-hosting'],
  },
  {
    title: 'Reference',
    summary: 'Answers to the things that go wrong, and the words this product uses.',
    slugs: ['troubleshooting', 'faq', 'ai-agents'],
  },
];

/** Every documentation slug, in reading order. */
export const DOC_SLUGS: readonly string[] = DOCS_SECTIONS.flatMap((section) => section.slugs);

/** The route a slug is published at. */
export function docHref(slug: string): string {
  return `/docs/${slug}`;
}

/** The raw markdown a machine reads, served from `public/docs`. */
export function docRawHref(slug: string): string {
  return `/docs/${slug}.md`;
}
