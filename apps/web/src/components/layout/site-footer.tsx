import Link from 'next/link';

import { GitHubIcon } from '@/components/ui/icons';
import { REPO_URL } from '@/lib/site';
import { LogoMark, PlayxoftMark } from './logo';

/**
 * The footer on every public page. Paired with `SiteHeader`.
 *
 * ── Why it is this large ──
 * A footer is the second navigation of a content site. Somebody who has read to
 * the bottom of a blog post has finished the thing they came for, and the honest
 * options at that moment are: read another one, look at the product, or check
 * what it costs. Four columns of real links answer that; a row of six links
 * and a copyright does not.
 *
 * ── The oversized mark ──
 * The wordmark across the base is the one purely decorative element on the
 * site. It sits at `--line`-adjacent contrast, well below body text, so it
 * reads as the page's closing sign-off rather than as something to click. It
 * is `aria-hidden` for exactly that reason — a screen reader announcing the
 * product name a third time at the end of every page is noise, and the two
 * places above it that *are* links already name it.
 */

const PRODUCT = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs/quickstart', label: 'Quickstart' },
  { href: '/docs/cli/commands', label: 'CLI reference' },
  { href: '/docs/api/reference', label: 'HTTP API' },
  { href: '/docs/self-hosting', label: 'Self-hosting' },
] as const;

const RESOURCES = [
  { href: '/docs', label: 'Documentation' },
  { href: '/blog', label: 'Blog' },
  { href: '/faq', label: 'FAQ' },
  { href: '/docs/guides/nextjs', label: 'Framework guides' },
  { href: '/docs/troubleshooting', label: 'Troubleshooting' },
  { href: '/docs/ai-agents', label: 'For AI agents' },
] as const;

const COMPANY = [
  { href: '/about', label: 'About' },
  { href: '/docs/security/trust-model', label: 'Trust model' },
  { href: '/docs/security/audit-log', label: 'Audit log' },
] as const;

const LEGAL = [
  { href: '/privacy', label: 'Privacy policy' },
  { href: '/terms', label: 'Terms of service' },
  { href: '/docs/security/trust-model', label: 'Security' },
] as const;

const LINK_CLASS = 'text-fg-muted hover:text-fg rounded-sm text-sm transition-colors';

function Column({
  title,
  links,
}: {
  title: string;
  links: readonly { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="text-fg text-xs font-semibold tracking-[0.12em] uppercase">{title}</h2>
      <ul className="mt-4 flex flex-col gap-2.5">
        {links.map((link) => (
          <li key={link.href + link.label}>
            <Link href={link.href} className={LINK_CLASS}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter({ gradientId }: { gradientId?: string | undefined }) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-line-subtle bg-canvas-inset/40 mt-auto border-t">
      <div className="x-container py-14 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] lg:gap-8">
          {/* Brand column. Wider than the link columns because it carries a
              sentence, and a sentence set to the width of a list of links
              breaks after two words. */}
          <div className="max-w-sm">
            <Link href="/" aria-label="xecret home" className="inline-flex items-center gap-2.5">
              <LogoMark className="size-9" gradientId={gradientId} />
              <span className="text-fg text-lg font-semibold tracking-tight">xecret</span>
            </Link>
            <p className="text-fg-muted mt-4 text-sm leading-6">
              Open-source secret management for developers. Encrypted per environment, audited on
              every read, and injected into your app with one command.
            </p>
            <div className="mt-5 flex items-center gap-3">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="xecret on GitHub"
                className="border-line text-fg-muted hover:bg-surface-hover hover:text-fg grid size-9 place-items-center rounded-full border transition-colors"
              >
                <GitHubIcon className="size-[1.05rem]" />
              </a>
              <PlayxoftMark />
            </div>
          </div>

          <Column title="Product" links={PRODUCT} />
          <Column title="Resources" links={RESOURCES} />
          <Column title="Company" links={COMPANY} />
          <Column title="Legal" links={LEGAL} />
        </div>

        <div className="border-line-subtle mt-12 flex flex-col gap-4 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-fg-subtle text-sm">© {year} Playxoft. Server AGPL-3.0, CLI MIT.</p>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/sign-in" className={LINK_CLASS}>
              Sign in
            </Link>
            <Link href="/sign-up" className={LINK_CLASS}>
              Start free
            </Link>
            <a href="/llms.txt" className={LINK_CLASS}>
              llms.txt
            </a>
          </nav>
        </div>

        {/* The sign-off. `select-none` because a reader dragging over the end of
            the page should not sweep up a 200px word that is not text. */}
        <p
          aria-hidden="true"
          className="x-footer-mark mt-10 -mb-3 w-full text-center text-[18vw] leading-none font-semibold tracking-[-0.05em] select-none sm:text-[15vw] lg:-mb-6"
        >
          xecret
        </p>
      </div>
    </footer>
  );
}
