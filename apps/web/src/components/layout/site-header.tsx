import Link from 'next/link';

// Direct module imports rather than the barrels, for the reason given in
// app/layout.tsx: this header renders on prerendered public pages, and a
// barrel would drag the dashboard's dependencies onto them.
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { REPO_URL, SITE_NAV } from '@/lib/site';
import type { NavKey } from '@/lib/site';
import { Wordmark } from './logo';
import { MobileNav } from './mobile-nav';
import { ThemeToggle } from './theme-toggle';

/**
 * The bar across every public page — the landing page, the marketing pages,
 * the blog, the legal pages and all of `/docs`.
 *
 * A floating pill rather than a full-width bar bolted to the top edge: the
 * canvas running past it on all four sides is what makes a page read as a
 * document on a surface rather than as application chrome. `pt-4` keeps it off
 * the viewport top while sticky.
 *
 * Shared rather than copied, so the marketing pages and the documentation
 * cannot drift into looking like two different products — which is exactly
 * what happens when docs are bolted on beside a landing page.
 *
 * ── What ships to the browser ──
 * This is a Server Component, so the five nav links cost nothing but markup.
 * The two things that genuinely need a client — the theme toggle and the
 * mobile drawer — are separate components, and they are the only JavaScript a
 * reader downloads for the chrome of a static page.
 *
 * @param current Which nav entry to mark with `aria-current`. Passed by each
 *   page rather than derived from `usePathname`, which would make the whole
 *   header a client component to underline one link.
 * @param wide Widens the pill to the documentation's container. The default
 *   matches the marketing pages' measure.
 */
export function SiteHeader({
  current,
  wide = false,
}: {
  current?: NavKey | undefined;
  wide?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      <div
        className={cn(
          'border-line bg-surface/70 mx-auto flex h-14 w-full items-center gap-2 rounded-2xl border px-3 backdrop-blur-xl sm:px-4',
          wide ? 'max-w-[88rem]' : 'max-w-[80rem]',
        )}
      >
        <Link href="/" aria-label="xecret home" className="shrink-0 rounded-sm">
          <Wordmark />
        </Link>
        <span className="border-line text-fg-subtle ml-1 hidden rounded-full border px-2 py-0.5 text-xs sm:inline">
          Pre-alpha
        </span>

        {/* The links sit in the middle of the bar on large screens and are
            replaced by the drawer below `lg`. Five items plus a wordmark plus
            three controls is more than a 1024px bar can hold without the nav
            crowding the sign-in button. */}
        <nav aria-label="Primary" className="mx-auto hidden items-center gap-0.5 lg:flex">
          {SITE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current === item.key ? 'page' : undefined}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                current === item.key
                  ? 'bg-surface-hover text-fg'
                  : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          <ThemeToggle />

          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="xecret on GitHub"
            className="text-fg-muted hover:bg-surface-hover hover:text-fg hidden size-9 place-items-center rounded-full transition-colors sm:grid"
          >
            <GitHubIcon className="size-[1.05rem]" />
          </a>

          <Button asChild variant="primary" size="sm" className="ml-1 rounded-full">
            <Link href="/sign-in">Sign in</Link>
          </Button>

          <MobileNav current={current} />
        </div>
      </div>
    </header>
  );
}
