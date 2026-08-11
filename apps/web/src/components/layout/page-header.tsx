import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface PageHeaderProps {
  title: string;
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
export function PageHeader({ title, description, badge, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-fg truncate text-xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="text-fg-muted mt-1.5 max-w-2xl text-sm leading-6">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
