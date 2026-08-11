'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export type LabelProps = ComponentProps<typeof LabelPrimitive.Root>;

/**
 * Radix's label rather than a bare `<label>`: it also forwards a click on the
 * label to the control when that control is a custom widget (our `Checkbox`
 * and `Switch` are buttons, and a native `<label for>` does not activate a
 * `<button>`).
 */
export function Label({ className, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'text-fg text-[0.8125rem] leading-5 font-medium',
        // Matches the control's own disabled treatment when the field is off.
        'peer-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    />
  );
}
