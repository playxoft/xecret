import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import type { NavKey } from '@/lib/site';

/**
 * The frame every public page renders inside: skip link, header, `<main>`,
 * footer.
 *
 * A component rather than a route-group `layout.tsx` because the header needs
 * to know which nav entry is current, and a layout cannot be told that by the
 * page inside it. The alternative is deriving it from `usePathname`, which
 * turns the header — five static links on a prerendered page — into a client
 * component. This costs one wrapper per page and keeps the chrome free.
 *
 * The skip link is the part that must not be re-typed per page. It is the
 * first focusable thing in the document and the only way a keyboard user
 * reaches an article without tabbing through nine navigation links, and it is
 * exactly the sort of detail that is present on the first page written and
 * absent from the eighth.
 */
export function PublicPage({
  current,
  children,
}: {
  current?: NavKey | undefined;
  children: ReactNode;
}) {
  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="bg-surface text-fg border-line sr-only z-50 rounded-md border px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <SiteHeader current={current} />

      <main id="main-content" className="flex-1">
        {children}
      </main>

      {/* The header above already rendered the mark under the default gradient
          id, so the footer's instance names its own. Two `<linearGradient>`
          elements sharing an id paint correctly only while they match, and
          resolve to whichever came first the moment they stop. */}
      <SiteFooter gradientId="xecret-mark-gradient-footer" />
    </div>
  );
}
