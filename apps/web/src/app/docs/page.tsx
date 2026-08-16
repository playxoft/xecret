import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { ArrowRightIcon, BookIcon, KeyIcon, TerminalIcon, UsersIcon } from '@/components/ui/icons';
import { absoluteUrl, SITE_KEYWORDS, SITE_NAME } from '@/lib/site';
import { loadNav } from './_lib/content';

const TITLE = 'xecret documentation';
const DESCRIPTION =
  'Everything needed to use xecret: the five-minute quickstart, the full CLI reference, framework and CI guides, the HTTP API, the security model, and self-hosting.';

export const metadata: Metadata = {
  // An absolute title, so this page reads as "xecret documentation" rather
  // than being run through the root layout's "%s · xecret" template into
  // "xecret documentation · xecret".
  title: { absolute: TITLE },
  description: DESCRIPTION,
  keywords: [
    'xecret docs',
    'secret management documentation',
    'xecret cli reference',
    'environment variable management',
    ...SITE_KEYWORDS,
  ],
  alternates: { canonical: absoluteUrl('/docs') },
  openGraph: {
    type: 'website',
    url: absoluteUrl('/docs'),
    siteName: SITE_NAME,
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  robots: { index: true, follow: true },
};

const START_HERE = [
  {
    href: '/docs/quickstart',
    title: 'Quickstart',
    body: 'Sign up, import the .env you already have, and start your app with secrets injected. About five minutes.',
    Icon: ArrowRightIcon,
  },
  {
    href: '/docs/concepts',
    title: 'Core concepts',
    body: 'Organisations, projects, environments, secrets and versions — the five words the rest of the documentation assumes.',
    Icon: BookIcon,
  },
  {
    href: '/docs/cli/commands',
    title: 'CLI reference',
    body: 'Every command and flag, with the exit conventions and what each one writes where.',
    Icon: TerminalIcon,
  },
  {
    href: '/docs/guides/ci',
    title: 'Secrets in CI',
    body: 'Service tokens end to end: GitHub Actions, GitLab, CircleCI and Docker builds.',
    Icon: KeyIcon,
  },
] as const;

export default async function DocsHomePage() {
  const sections = await loadNav();

  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${absoluteUrl('/docs')}#page`,
        name: TITLE,
        description: DESCRIPTION,
        inLanguage: 'en',
        publisher: { '@type': 'Organization', name: 'Playxoft', url: 'https://playxoft.com' },
      },
      {
        '@type': 'ItemList',
        '@id': `${absoluteUrl('/docs')}#contents`,
        name: 'Documentation contents',
        itemListElement: sections
          .flatMap((section) => section.items)
          .map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: item.title,
            description: item.description,
            url: absoluteUrl(item.href),
          })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${absoluteUrl('/docs')}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: absoluteUrl('/') },
          { '@type': 'ListItem', position: 2, name: 'Documentation', item: absoluteUrl('/docs') },
        ],
      },
    ],
  };

  return (
    <main id="doc-content" className="w-full min-w-0 px-5 py-10 sm:py-14 lg:px-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <div className="max-w-3xl">
        <h1 className="text-fg text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          xecret documentation
        </h1>
        <p className="text-fg-muted mt-4 text-base leading-7">
          xecret stores your environment variables once, encrypted per environment, and injects them
          into whatever you are running — your laptop, your CI job, your container. These pages
          cover all of it, from the first command to running the whole thing on your own
          infrastructure.
        </p>
        <p className="text-fg-muted mt-3 text-base leading-7">
          New here? Start with the{' '}
          <Link href="/docs/quickstart" className="text-accent-text font-medium hover:underline">
            quickstart
          </Link>
          . If you have never used a secret manager before, read{' '}
          <Link
            href="/docs/what-is-xecret"
            className="text-accent-text font-medium hover:underline"
          >
            what xecret is
          </Link>{' '}
          first — it assumes nothing.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild variant="primary" size="lg">
            <Link href="/docs/quickstart">
              Start the quickstart
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/docs/cli/commands">
              <TerminalIcon className="size-4" />
              CLI reference
            </Link>
          </Button>
        </div>
      </div>

      <section aria-labelledby="start-here" className="mt-14">
        <h2 id="start-here" className="text-fg text-lg font-semibold tracking-tight">
          Start here
        </h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {START_HERE.map(({ href, title, body, Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="border-line bg-surface hover:border-line-strong group flex h-full flex-col gap-2 rounded-xl border p-5 transition-colors"
              >
                <Icon className="text-accent-text size-5" />
                <span className="text-fg group-hover:text-accent-text text-sm font-semibold">
                  {title}
                </span>
                <span className="text-fg-muted text-sm leading-6">{body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* The full table of contents, in reading order. Deliberately every page
          with its own one-line summary rather than a list of bare links: this
          is the page a search engine and an unfamiliar reader both land on, and
          both are deciding which of twenty-odd documents answers them. */}
      <section aria-labelledby="contents" className="mt-16">
        <h2 id="contents" className="text-fg text-lg font-semibold tracking-tight">
          Table of contents
        </h2>

        <div className="mt-6 grid gap-x-12 gap-y-10 lg:grid-cols-2">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-fg text-sm font-semibold">{section.title}</h3>
              <p className="text-fg-subtle mt-1 text-sm leading-6">{section.summary}</p>
              <ul className="border-line-subtle mt-3 flex flex-col border-t">
                {section.items.map((item) => (
                  <li key={item.href} className="border-line-subtle border-b">
                    <Link href={item.href} className="group block py-3">
                      <span className="text-fg group-hover:text-accent-text text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="text-fg-muted mt-0.5 block text-sm leading-6">
                        {item.description}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="for-machines"
        className="border-accent-line bg-accent-tint/40 mt-16 max-w-3xl rounded-xl border p-6"
      >
        <div className="flex items-center gap-2.5">
          <UsersIcon className="text-accent-text size-5 shrink-0" />
          <h2 id="for-machines" className="text-fg text-base font-semibold tracking-tight">
            Reading this with an AI agent?
          </h2>
        </div>
        <p className="text-fg-muted mt-3 text-sm leading-7">
          Every page is published twice: as the HTML you are reading, and as the markdown it was
          written in. Append <code className="font-mono">.md</code> to any documentation URL to get
          the source — <code className="font-mono">/docs/cli/commands.md</code>, for instance. There
          is an index at{' '}
          <Link href="/llms.txt" className="text-accent-text font-medium hover:underline">
            /llms.txt
          </Link>{' '}
          and the entire documentation set concatenated into one file at{' '}
          <Link href="/llms-full.txt" className="text-accent-text font-medium hover:underline">
            /llms-full.txt
          </Link>
          .
        </p>
        <p className="text-fg-muted mt-3 text-sm leading-7">
          <Link href="/docs/ai-agents" className="text-accent-text font-medium hover:underline">
            Using xecret with AI agents
          </Link>{' '}
          covers the part that matters more: how to let a coding agent run your app without handing
          it your production credentials.
        </p>
      </section>
    </main>
  );
}
