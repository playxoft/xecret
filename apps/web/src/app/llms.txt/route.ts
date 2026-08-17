import { loadPosts, postHref } from '../blog/_lib/posts';
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
 * cannot list a page that does not exist or miss one that does. The blog is
 * appended from its own directory listing for the same reason.
 *
 * The marketing pages are named in an `Optional` section rather than listed as
 * markdown, because they are components rather than files — there is no `.md`
 * to point at, and linking an agent to HTML it would have to strip is worse
 * than telling it plainly where the same facts live in prose.
 */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const sections = await loadNav();
  const posts = await loadPosts();

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

  if (posts.length > 0) {
    lines.push('## Blog', '');
    for (const post of posts) {
      lines.push(
        `- [${post.title}](${absoluteUrl(`${postHref(post.slug)}.md`)}): ${post.description}`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Optional',
    '',
    `- [Features](${absoluteUrl('/features')}): what the product does, in detail.`,
    `- [Pricing](${absoluteUrl('/pricing')}): plans, limits and what each tier includes.`,
    `- [FAQ](${absoluteUrl('/faq')}): the questions asked before signing up.`,
    `- [About](${absoluteUrl('/about')}): why this exists and what it commits to.`,
    `- [Privacy policy](${absoluteUrl('/privacy')}) and [Terms](${absoluteUrl('/terms')}).`,
    '',
  );

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
