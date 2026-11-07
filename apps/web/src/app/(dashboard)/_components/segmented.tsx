'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * A pill of mutually exclusive choices — a plan, a billing period.
 *
 * Shared by the billing screen and the plans page, which both ask "monthly or
 * yearly?" and must look like the same question when somebody moves from one
 * to the other.
 *
 * `label` on an option is a node rather than a string so a choice can carry a
 * chip beside its name — "Yearly · Save up to 37%" — inside the radio, where
 * it becomes part of what a screen reader announces for that choice.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('border-line bg-canvas-inset inline-flex rounded-full border p-1', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            option.value === value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
