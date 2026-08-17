import Link from 'next/link';

// Direct module imports rather than the barrels, for the reason given in
// app/layout.tsx: this header renders on prerendered public pages, and a
// barrel would drag the dashboard's dependencies onto them.
import { Button } from '@/components/ui/button';
import { BookIcon, GitHubIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Wordmark } from './logo';

const REPO_URL = 'https://github.com/playxoft/xecret';

/**
 * The bar across every public page — the landing page and all of `/docs`.
 *
 * A floating pill rather than a full-width bar bolted to the top edge: the
 * canvas running past it on all four sides is what makes a page read as a
 * document on a surface rather than as application chrome. `pt-4` keeps it off
 * the viewport top while sticky.
 *
 * Shared rather than copied, so the marketing page and the documentation cannot
 * drift into looking like two different products — which is exactly what
 * happens when docs are bolted on beside a landing page.
 *
 * @param wide Widens the pill to the documentation's container. The default
 *   matches the landing page's `max-w-5xl` column.
 */
export function SiteHeader({
  current,
  wide = false,
}: {
  current?: 'docs' | undefined;
  wide?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      <div
        className={cn(
          'border-line bg-surface/70 mx-auto flex h-14 w-full items-center gap-4 rounded-2xl border px-3 backdrop-blur-xl sm:px-4',
          wide ? 'max-w-[88rem]' : 'max-w-5xl',
        )}
      >
        <Link href="/" aria-label="xecret home" className="rounded-sm">
          <Wordmark />
        </Link>
        <span className="border-line text-fg-subtle ml-1 hidden rounded-full border px-2 py-0.5 text-xs sm:inline">
          Pre-alpha
        </span>

        <nav aria-label="Primary" className="ml-auto flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="rounded-full">
            <Link href="/docs" aria-current={current === 'docs' ? 'page' : undefined}>
              <BookIcon className="size-4" />
              <span className="hidden sm:inline">Docs</span>
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="rounded-full">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              <GitHubIcon className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </Button>
          <Button asChild variant="primary" size="sm" className="ml-1 rounded-full">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
