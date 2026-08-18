'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { CheckIcon, MinusIcon } from './icons';

export type CheckboxProps = ComponentProps<typeof CheckboxPrimitive.Root>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  const fieldProps = useFieldControl();

  return (
    <CheckboxPrimitive.Root
      {...fieldProps}
      className={cn(
        // An unchecked box is an empty 17px square: no glyph, no label, a fill
        // 1.09:1 from the card. The border is the entire control, which is why
        // it takes `--line-control` and not the hairline token.
        'border-line-control bg-canvas-inset grid size-[1.05rem] shrink-0 place-items-center rounded-[0.3rem] border',
        'transition-colors duration-150',
        'hover:enabled:border-fg-subtle',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-fg',
        'disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...props}
    >
      {/* Radix renders the indicator only when checked or indeterminate, so
          both glyphs can be present without a state check here. */}
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.checked === 'indeterminate' ? (
          <MinusIcon className="size-3 stroke-[3]" />
        ) : (
          <CheckIcon className="size-3 stroke-[3]" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
