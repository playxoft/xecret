import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

/**
 * Table primitives.
 *
 * A real `<table>`, not a grid of divs: secret listings, audit logs, and member
 * lists are tabular data, and only a real table gives a screen reader row and
 * column context ("row 4 of 60, Name, DATABASE_URL") as the user moves through
 * it. The horizontal scroll lives on a wrapper so the table itself keeps its
 * semantics.
 */
export function TableContainer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-scroll-region=""
      // Scrollable regions must be reachable by keyboard, or a user without a
      // mouse cannot see the columns that overflow. `tabIndex={0}` plus a role
      // and a name is the documented pattern for this.
      tabIndex={0}
      role="region"
      className={cn(
        'border-line bg-surface overflow-x-auto rounded-xl border',
        // The default focus ring sits outside the border radius here, so it is
        // pulled flush; the container is a scroll region, not a control.
        'focus-visible:outline-offset-0',
        className,
      )}
      {...props}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      className={cn('bg-canvas-inset border-line-subtle border-b [&_tr]:border-0', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-line-subtle divide-y', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('hover:bg-surface-hover transition-colors', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'text-fg-subtle h-9 px-3 text-left text-xs font-medium tracking-wide whitespace-nowrap',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('text-fg px-3 py-2.5 align-middle', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('text-fg-subtle mt-3 text-xs', className)} {...props} />;
}
