'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { CloseIcon, GitHubIcon, MenuIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { REPO_URL, SITE_NAV } from '@/lib/site';
import type { NavKey } from '@/lib/site';
import { Wordmark } from './logo';

/**
 * The primary navigation below `lg`, as a sheet from the right.
 *
 * Split out of `SiteHeader` so that the header itself stays a Server
 * Component: this is the only part that needs state, and it is the only part
 * that costs the reader any JavaScript.
 *
 * A full sheet rather than a dropdown, because on a phone a dropdown of six
 * links either scrolls under the thumb or runs off the bottom of a short
 * viewport. The sheet also puts the actions where a thumb reaches — the bottom
 * of the panel, not the top.
 *
 * ── Why the sheet is portalled ──
 * This is not a preference; without it the menu does not work at all.
 *
 * The header pill carries `backdrop-blur-xl`, and an element with a
 * `backdrop-filter` becomes the *containing block* for every `position: fixed`
 * descendant — the same rule `transform` and `filter` have. So a sheet
 * rendered in place resolved its `inset-0` against the 56px-tall header pill
 * instead of against the viewport, and opened as an invisible sliver behind
 * the bar. Nothing about the markup or the state was wrong, which is what
 * makes this failure hard to find by reading the component.
 *
 * Portalling to `document.body` puts the sheet outside that containing block,
 * where `fixed` means what it says.
 */
export function MobileNav({ current }: { current?: NavKey | undefined }) {
  // `document` does not exist during server rendering, and `createPortal`
  // below reads it. No guard is needed for that: `open` starts false and only
  // a click can set it, so the portal branch is unreachable on the server and
  // on the hydrating render. A `mounted` flag here would be an effect, a
  // second render pass, and a lint suppression, all to re-derive something
  // `open` already tells us.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);

    // The page behind an open sheet must not scroll: on iOS a swipe over the
    // overlay otherwise scrolls the document underneath while the sheet stays
    // put, which reads as a broken page rather than as a modal.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Open menu"
        className="text-fg-muted hover:bg-surface-hover hover:text-fg grid size-9 place-items-center rounded-full transition-colors lg:hidden"
      >
        <MenuIcon className="size-[1.15rem]" />
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 lg:hidden">
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="bg-overlay absolute inset-0 h-full w-full"
              />
              <div className="bg-canvas border-line absolute inset-y-0 right-0 flex w-[20rem] max-w-[86vw] flex-col border-l">
                <div className="border-line-subtle flex h-16 shrink-0 items-center justify-between border-b px-5">
                  <Wordmark gradientId="xecret-mark-gradient-mobile-nav" />
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close menu"
                    className="text-fg-muted hover:bg-surface-hover hover:text-fg grid size-9 place-items-center rounded-full"
                  >
                    <CloseIcon className="size-[1.05rem]" />
                  </button>
                </div>

                <nav aria-label="Primary" className="flex-1 overflow-y-auto p-4">
                  <ul className="flex flex-col gap-0.5">
                    {SITE_NAV.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          // Closed here rather than in an effect on the pathname:
                          // it also covers tapping the page you are already on,
                          // which produces no navigation and so no effect.
                          onClick={() => setOpen(false)}
                          aria-current={current === item.key ? 'page' : undefined}
                          className={cn(
                            'block rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium transition-colors',
                            current === item.key
                              ? 'bg-surface-hover text-fg'
                              : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>

                  <div className="border-line-subtle mt-4 flex flex-col gap-0.5 border-t pt-4">
                    <Link
                      href="/faq"
                      onClick={() => setOpen(false)}
                      className="text-fg-muted hover:bg-surface-hover hover:text-fg block rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium transition-colors"
                    >
                      FAQ
                    </Link>
                    <a
                      href={REPO_URL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-fg-muted hover:bg-surface-hover hover:text-fg flex items-center gap-2 rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium transition-colors"
                    >
                      <GitHubIcon className="size-4" />
                      GitHub
                    </a>
                  </div>
                </nav>

                <div className="border-line-subtle flex shrink-0 flex-col gap-2 border-t p-4">
                  <Link
                    href="/sign-up"
                    onClick={() => setOpen(false)}
                    className="bg-accent text-accent-fg hover:bg-accent-hover flex h-11 items-center justify-center rounded-full text-[0.9375rem] font-medium transition-colors"
                  >
                    Start free
                  </Link>
                  <Link
                    href="/sign-in"
                    onClick={() => setOpen(false)}
                    className="border-line text-fg hover:bg-surface-hover flex h-11 items-center justify-center rounded-full border text-[0.9375rem] font-medium transition-colors"
                  >
                    Sign in
                  </Link>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
