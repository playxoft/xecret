import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'production';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-canvas-inset text-fg-muted',
  accent: 'border-accent-line bg-accent-tint text-accent-text',
  success: 'border-success-line bg-success-tint text-success-text',
  warning: 'border-warning-line bg-warning-tint text-warning-text',
  danger: 'border-danger-line bg-danger-tint text-danger-text',
  production: 'x-hazard border-production-line bg-production-tint text-production-text',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children?: ReactNode;
}

/**
 * A small status chip.
 *
 * The `production` tone is the only place in the design system permitted to
 * use the production colour, and it never relies on that colour alone: it adds
 * uppercase letterforms and the diagonal hazard hatching from `globals.css`.
 * A user with deuteranopia, a greyscale print-out, and a failing external
 * monitor all still distinguish it from `warning`.
 */
export function Badge({ className, tone = 'neutral', children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium',
        tone === 'production' && 'font-semibold tracking-[0.06em] uppercase',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
