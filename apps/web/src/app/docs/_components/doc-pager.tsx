import Link from 'next/link';

import { ArrowRightIcon } from '@/components/ui/icons';
import type { Pager } from '../_lib/content';

/**
 * Previous / next, in the reading order declared by `nav.ts`.
 *
 * Documentation is read two ways — searched into the middle of, or worked
 * through front to back — and this serves the second without penalising the
 * first.
 */
export function DocPager({ previous, next }: Pager) {
  if (!previous && !next) return null;

  return (
    <nav
      aria-label="Documentation pages"
      className="border-line-subtle mt-14 grid gap-3 border-t pt-8 sm:grid-cols-2"
    >
      {previous ? (
        <Link
          href={previous.href}
          className="border-line bg-surface hover:border-line-strong group flex flex-col gap-1 rounded-lg border p-4 transition-colors"
        >
          <span className="text-fg-subtle inline-flex items-center gap-1.5 text-xs">
            <ArrowRightIcon className="size-3.5 rotate-180" />
            Previous
          </span>
          <span className="text-fg group-hover:text-accent-text text-sm font-medium">
            {previous.title}
          </span>
        </Link>
      ) : (
        <span />
      )}

      {next ? (
        <Link
          href={next.href}
          className="border-line bg-surface hover:border-line-strong group flex flex-col items-end gap-1 rounded-lg border p-4 text-right transition-colors sm:col-start-2"
        >
          <span className="text-fg-subtle inline-flex items-center gap-1.5 text-xs">
            Next
            <ArrowRightIcon className="size-3.5" />
          </span>
          <span className="text-fg group-hover:text-accent-text text-sm font-medium">
            {next.title}
          </span>
        </Link>
      ) : null}
    </nav>
  );
}
