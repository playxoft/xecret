import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * A loading placeholder.
 *
 * Always `aria-hidden`: a screen reader announcing "blank blank blank" while
 * content loads is noise. The region that owns the skeletons should carry
 * `aria-busy="true"` instead, so assistive technology hears one status change
 * rather than a dozen empty boxes.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-surface-active animate-pulse rounded-md', className)}
      {...props}
    />
  );
}
