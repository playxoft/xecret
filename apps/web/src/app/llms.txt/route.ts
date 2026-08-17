import { loadNav } from '../docs/_lib/content';
import { absoluteUrl, SITE_TAGLINE } from '@/lib/site';

/**
 * `/llms.txt` — the documentation index, for machines.
 *
 * Follows the llmstxt.org convention: a title, a one-line summary, then link
 * lists grouped by section, each entry pointing at the *markdown* rather than
 * the rendered page. An agent that follows one of these links gets the source
 * the page was built from, with no navigation chrome to parse around.
 *
 * Generated from the same manifest and frontmatter the sidebar uses, so it
 * cannot list a page that does not exist or miss one that does.
 */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const sections = await loadNav();

  const lines: string[] = [
    '# xecret',
    '',
    `> ${SITE_TAGLINE}. Store environment variables once, encrypted per environment, and inject them into any process — locally, in CI, in production — without writing a .env file to disk.`,
    '',
    'Every page below is published twice: as HTML at the path shown, and as the markdown it was written in at the same path with `.md` appended. The links here point at the markdown.',
    '',
    `The whole documentation set concatenated into one file: ${absoluteUrl('/llms-full.txt')}`,
    '',
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}`, '');
    for (const item of section.items) {
      lines.push(`- [${item.title}](${absoluteUrl(`${item.href}.md`)}): ${item.description}`);
    }
    lines.push('');
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
