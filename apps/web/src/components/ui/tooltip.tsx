'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Mount once, near the root. Radix uses it to share the "skip delay" timer, so
 * moving between adjacent icon buttons shows the second tooltip instantly
 * instead of waiting out the open delay again.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    >
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** The trigger. Must accept a ref and spread props — Radix uses `asChild`. */
  children: ReactNode;
  content: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
  align?: ComponentProps<typeof TooltipPrimitive.Content>['align'];
}

/**
 * A hint attached to a control.
 *
 * A tooltip is never the only place information lives. It does not appear on
 * touch devices, it vanishes the moment the pointer leaves, and a control
 * whose *name* is only in a tooltip is unusable — put that in `aria-label` and
 * use the tooltip for the sighted-user hint alongside it.
 */
export function Tooltip({ children, content, side = 'top', align = 'center' }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'border-line bg-surface text-fg shadow-overlay z-50 max-w-64 rounded-md border px-2 py-1 text-xs leading-5',
            'data-[state=delayed-open]:animate-enter data-[state=closed]:animate-exit',
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
