import Link from 'next/link';

// Direct module imports rather than the barrels, for the reason given in
// app/layout.tsx: this header renders on prerendered public pages, and a
// barrel would drag the dashboard's dependencies onto them.
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/ui/icons';
// `Shortcut` is a Client Component, which a Server Component may render; the
// two `aria-` helpers are plain functions, and they come from the module that is
// *not* `'use client'` — calling one that is, from here, fails at render.
import { ariaKeyShortcuts } from '@/components/ui/aria-shortcuts';
import { Shortcut } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';
import { SIGN_IN_PATH } from '@/lib/session-hint';
import { REPO_URL, SIGN_IN_SHORTCUT_KEYS, SITE_NAV } from '@/lib/site';
import type { NavKey } from '@/lib/site';
import { Wordmark } from './logo';
import { MobileNav } from './mobile-nav';
import { SignInShortcut } from './sign-in-shortcut';
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
 * The things that genuinely need a client — the theme toggle, the mobile
 * drawer, and on the landing page alone the sign-in shortcut and its key cap —
 * are separate components, and they are the only JavaScript a reader downloads
 * for the chrome of a static page.
 *
 * @param current Which nav entry to mark with `aria-current`. Passed by each
 *   page rather than derived from `usePathname`, which would make the whole
 *   header a client component to underline one link.
 * @param wide Widens the pill to the documentation's container. The default
 *   matches the marketing pages' measure.
 * @param signInShortcut Binds `S` to sign-in and prints the cap on the button.
 *   Off by default, and on only on the landing page: a key cap is a promise,
 *   and advertising one on a page somebody arrived at to *read* — a blog post,
 *   a docs article — claims a letter they have better uses for. It is also the
 *   only thing on this header that costs a reader any JavaScript beyond the
 *   theme toggle and the drawer, which is reason enough not to ship it
 *   site-wide. See `SignInShortcut`.
 */
export function SiteHeader({
  current,
  wide = false,
  signInShortcut = false,
}: {
  current?: NavKey | undefined;
  wide?: boolean;
  signInShortcut?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 px-4 pt-4">
      <div
        className={cn(
          'border-line bg-surface/70 mx-auto flex h-14 w-full items-center gap-2 rounded-2xl border px-3 backdrop-blur-xl sm:px-4',
          wide ? 'max-w-[88rem]' : 'max-w-[80rem]',
        )}
      >
        {/* One size up from the wordmark's default, which the rest of the
            application uses. This is the only place the mark has to identify
            the product to somebody who has just arrived, rather than remind
            somebody already inside it — and the badge that used to sit beside
            it is gone, so it has the room. */}
        {/* `flex items-center`, not the bare inline anchor this used to be.
            `Wordmark` is an inline-flex span, so inside an inline anchor it was
            laid out on that anchor's text baseline — which reserved a
            descender's worth of space under it that nothing was using, made
            the anchor 35px tall inside a 56px bar, and left the whole lockup
            sitting 3px above the centre the nav links were on. A flex
            container has no baseline to sit on and no line box to pad. */}
        <Link href="/" aria-label="xecret home" className="flex shrink-0 items-center rounded-sm">
          <Wordmark className="text-lg" />
        </Link>

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

          {/* `aria-keyshortcuts` on the control, caps beside the label: the
              caps are `aria-hidden`, because read aloud they turn this
              button's name into "Sign in S". `components/ui/kbd.tsx` has the
              long version of that. The caps are hidden below `sm` — on a
              360px bar they crowd the one button that matters, and nobody
              holding a phone has an `S` key to press. */}
          <Button asChild variant="primary" size="sm" className="ml-1 rounded-full">
            <Link
              href={SIGN_IN_PATH}
              aria-keyshortcuts={
                signInShortcut ? ariaKeyShortcuts(SIGN_IN_SHORTCUT_KEYS) : undefined
              }
            >
              Sign in
              {signInShortcut ? (
                <Shortcut keys={SIGN_IN_SHORTCUT_KEYS} className="-mr-0.5 hidden sm:inline-flex" />
              ) : null}
            </Link>
          </Button>

          {signInShortcut ? <SignInShortcut /> : null}

          <MobileNav current={current} />
        </div>
      </div>
    </header>
  );
}
