'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'flex items-center gap-1',
        // Many tabs on a narrow screen scroll rather than wrap: a wrapped tab
        // bar changes height as the selection moves and pushes the panel down.
        // Sideways only. A box that scrolls on one axis scrolls on both, and
        // the bar is one line by construction, so anything that ever reaches
        // past its bottom edge is clipped rather than offered as a vertical
        // scrollbar a pixel or two deep.
        'overflow-x-auto overflow-y-hidden',
        // The hairline under the tabs is a shadow inside the list, not its
        // border, which is what put that scrollbar there: the selected tab's
        // underline was laid over a border by pulling each tab a pixel down
        // into it, and a pixel hanging out of a box that scrolls is a pixel
        // of vertical overflow. Drawn inside, the line sits under the tabs'
        // own underlines with nothing reaching past the list — the settings
        // nav's row does the same, for the same reason.
        'shadow-[inset_0_-1px_0_var(--line-subtle)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'text-fg-muted relative shrink-0 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium',
        'transition-colors duration-150',
        'hover:text-fg',
        // The selected tab is marked by an underline as well as a colour, so
        // the selection survives greyscale and colour vision deficiency.
        'data-[state=active]:border-accent data-[state=active]:text-fg',
        'disabled:text-fg-disabled disabled:pointer-events-none',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-4', className)} {...props} />;
}
