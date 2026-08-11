import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  /** A decorative glyph. Keep it muted — it is scenery, not a control. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** The one action that resolves the emptiness. */
  action?: ReactNode;
  /** A secondary route out, usually a documentation link. */
  secondaryAction?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'border-line flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="border-line bg-canvas-inset text-fg-subtle mb-4 grid size-11 place-items-center rounded-lg border text-xl"
        >
          {icon}
        </div>
      ) : null}
      <p className="text-fg text-[0.9375rem] font-semibold">{title}</p>
      {description ? (
        <p className="text-fg-muted mt-1.5 max-w-sm text-sm leading-6">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
