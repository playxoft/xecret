import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface PageHeaderProps {
  title: string;
  /**
   * Renders a placeholder in place of the title until the real one arrives.
   *
   * The screens that need it title themselves from a resource but have a slug
   * on hand from the URL, and the tempting `name ?? slug` writes the heading
   * twice: `development` for as long as the request takes, then `Development`.
   * A page whose first word changes under the reader is worse than a page that
   * takes a beat to have one, so this holds the space instead.
   */
  titleLoading?: boolean;
  description?: ReactNode;
  /** Sits beside the title — an environment badge, a status chip. */
  badge?: ReactNode;
  /** Primary and secondary actions for the page. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The heading block at the top of a page.
 *
 * The title is the page's only `<h1>`. Every dashboard page renders one, so
 * the document outline always starts at level one and "jump to heading" lands
 * somewhere useful.
 */
export function PageHeader({
  title,
  titleLoading = false,
  description,
  badge,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-fg truncate text-xl font-semibold tracking-tight">
            {titleLoading ? (
              <>
                {/* A `<span>` carrying the skeleton's styling rather than the
                    `Skeleton` primitive, which renders a `<div>`: `<h1>` takes
                    phrasing content, and the heading has to stay a heading. */}
                <span
                  aria-hidden="true"
                  className="bg-surface-active my-1 inline-block h-5 w-44 max-w-full animate-pulse rounded-md align-middle"
                />
                <span className="sr-only">Loading</span>
              </>
            ) : (
              title
            )}
          </h1>
          {titleLoading ? null : badge}
        </div>
        {description ? (
          <p className="text-fg-muted mt-1.5 max-w-2xl text-sm leading-6">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
