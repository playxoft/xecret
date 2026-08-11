import Link from 'next/link';
import { Fragment } from 'react';

import { cn } from '@/lib/cn';
import { ChevronRightIcon } from '@/components/ui/icons';

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page — the last crumb is never a link. */
  href?: string;
}

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  className?: string;
}

/**
 * The tenancy path — organisation → project → environment — which in this
 * product doubles as the answer to "which environment am I about to edit?".
 *
 * On narrow screens the ancestors are hidden rather than wrapped: a wrapping
 * breadcrumb changes the top bar's height, which shifts the whole page. They
 * are hidden with CSS, not dropped from the markup, so the full trail is still
 * available to a screen reader.
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="text-fg-muted flex min-w-0 items-center gap-1 text-sm">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 ? (
                <li aria-hidden="true" className="text-fg-subtle hidden shrink-0 sm:block">
                  <ChevronRightIcon className="size-3.5" />
                </li>
              ) : null}
              <li className={cn('min-w-0 truncate', !isLast && 'hidden sm:block')}>
                {item.href && !isLast ? (
                  <Link href={item.href} className="hover:text-fg rounded-sm transition-colors">
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-fg font-medium" aria-current={isLast ? 'page' : undefined}>
                    {item.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
