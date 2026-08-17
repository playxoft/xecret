'use client';

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';
import { useFieldControl } from './field';

export type SwitchProps = ComponentProps<typeof SwitchPrimitive.Root>;

/**
 * A switch takes effect immediately; a checkbox waits for a submit. Use this
 * only where flipping it is the action — "require approval for production
 * writes" — never inside a form with a Save button, where the two conventions
 * contradict each other.
 */
export function Switch({ className, ...props }: SwitchProps) {
  const fieldProps = useFieldControl();

  return (
    <SwitchPrimitive.Root
      {...fieldProps}
      className={cn(
        // Of every ground `--line-control` is drawn against, this track is the
        // one nearest the border's own luminance in both themes — so it is the
        // case that sets the token's value. See the Lines block in globals.css.
        'border-line-control bg-surface-active relative inline-flex h-[1.3rem] w-[2.3rem] shrink-0 items-center rounded-full border',
        'transition-colors duration-150',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'bg-fg-muted pointer-events-none block size-[0.9rem] translate-x-[0.15rem] rounded-full',
          'transition-transform duration-150',
          'data-[state=checked]:bg-accent-fg data-[state=checked]:translate-x-[1.15rem]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
