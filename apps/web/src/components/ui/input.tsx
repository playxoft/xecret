'use client';

import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cn } from '@/lib/cn';
import { useFieldControl } from './field';

export const INPUT_BASE =
  'w-full rounded-md border border-line-strong bg-canvas-inset text-fg text-sm ' +
  'transition-[border-color,background-color] duration-150 ' +
  'hover:enabled:border-fg-subtle focus-visible:border-accent ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:hover:enabled:border-danger ' +
  'disabled:cursor-not-allowed disabled:text-fg-disabled disabled:bg-surface-hover';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Decorative glyph inside the leading edge. Never a control. */
  startIcon?: ReactNode;
  /** Interactive slot on the trailing edge — a reveal toggle, a unit, a clear button. */
  endSlot?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, startIcon, endSlot, ref, ...props }: InputProps) {
  // Spread first so an explicit `id` or `aria-describedby` on the call site
  // still wins over the enclosing Field's.
  const fieldProps = useFieldControl();

  const input = (
    <input
      {...fieldProps}
      ref={ref}
      className={cn(
        INPUT_BASE,
        'h-9 px-3',
        startIcon && 'pl-9',
        endSlot && 'pr-10',
        // The browser's autofill background ignores our token colours; the
        // inset shadow repaints it without fighting `background-color`, which
        // WebKit refuses to override.
        'autofill:shadow-[inset_0_0_0_1000px_var(--canvas-inset)] autofill:[-webkit-text-fill-color:var(--fg)]',
        className,
      )}
      {...props}
    />
  );

  if (!startIcon && !endSlot) return input;

  return (
    <div className="relative flex items-center">
      {startIcon ? (
        <span
          aria-hidden="true"
          className="text-fg-subtle pointer-events-none absolute left-3 flex items-center text-base"
        >
          {startIcon}
        </span>
      ) : null}
      {input}
      {endSlot ? <span className="absolute right-1 flex items-center">{endSlot}</span> : null}
    </div>
  );
}
