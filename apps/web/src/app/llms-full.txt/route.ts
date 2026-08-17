import { loadDoc } from '../docs/_lib/content';
import { DOC_SLUGS, docHref } from '../docs/_lib/nav';
import { absoluteUrl, SITE_TAGLINE } from '@/lib/site';

/**
 * `/llms-full.txt` — every documentation page, in reading order, in one file.
 *
 * The companion to `/llms.txt`: that one is an index to follow, this one is the
 * whole corpus for an agent that would rather read once than fetch twenty-five
 * times. Each document keeps a header naming its canonical URL, so anything
 * quoted from here can be cited back to a page a person can open.
 */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const documents = await Promise.all(DOC_SLUGS.map((slug) => loadDoc(slug)));

  const parts: string[] = [
    '# xecret — complete documentation',
    '',
    `> ${SITE_TAGLINE}.`,
    '',
    'This file is every page of the xecret documentation concatenated in reading order.',
    `The index, with one link per page, is at ${absoluteUrl('/llms.txt')}.`,
    '',
    '---',
    '',
  ];

  for (const doc of documents) {
    parts.push(
      `# ${doc.title}`,
      '',
      `Source: ${absoluteUrl(docHref(doc.slug))}`,
      `Summary: ${doc.description}`,
      `Updated: ${doc.updated}`,
      '',
      // The body's own headings start at `##`, because the frontmatter title is
      // the `<h1>`. Concatenating the bodies under one `#` per document
      // therefore produces a single well-formed outline rather than a file with
      // twenty-five competing top-level headings.
      doc.markdown.trim(),
      '',
      '---',
      '',
    );
  }

  return new Response(parts.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
