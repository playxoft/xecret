'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'border-line-subtle flex items-center gap-1 border-b',
        // Many tabs on a narrow screen scroll rather than wrap: a wrapped tab
        // bar changes height as the selection moves and pushes the panel down.
        'overflow-x-auto',
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
        'text-fg-muted relative -mb-px shrink-0 rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium',
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
