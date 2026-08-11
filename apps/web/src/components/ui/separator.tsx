'use client';

import * as SeparatorPrimitive from '@radix-ui/react-separator';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export type SeparatorProps = ComponentProps<typeof SeparatorPrimitive.Root>;

/**
 * Radix defaults `decorative` to true, which renders `role="none"`. That is
 * almost always right: a rule drawn between two blocks of related content is
 * a visual grouping cue, and announcing "separator" for each one turns a
 * settings page into a list of separators.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        'bg-line shrink-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className,
      )}
      {...props}
    />
  );
}
