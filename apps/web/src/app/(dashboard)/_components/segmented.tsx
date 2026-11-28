'use client';

import type { KeyboardEvent, ReactNode } from 'react';

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
 *
 * ── A radio group, from the keyboard too ──
 * One tab stop for the whole pill, on the chosen option, and the arrow keys
 * (with Home and End) move the choice and the focus together, as the ARIA
 * radio group pattern has it. Each option used to be a tab stop of its own
 * that the arrows did nothing on, which a screen reader announced as a radio
 * group and a keyboard then contradicted. The next option is found from the
 * pressed button's own group rather than through refs, so the pill keeps no
 * state and calls no hooks.
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
  // The chosen option holds the tab stop; the first does when none is chosen,
  // so the group can never fall out of the tab order.
  const focusable = options.some((option) => option.value === value) ? value : options[0]?.value;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextOptionIndex(event.key, index, options.length);
    const option = next === null ? undefined : options[next];
    if (next === null || option === undefined) return;
    event.preventDefault();
    const radios =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.item(next)?.focus();
    onChange(option.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('border-line bg-canvas-inset inline-flex rounded-full border p-1', className)}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === focusable ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
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

/**
 * Where a key press moves the choice in a group of `count` options, from the
 * option at `index`: the next or previous one, wrapping round, for the arrow
 * keys; the first or last for Home and End; `null` for any other key, which
 * the group leaves alone.
 */
export function nextOptionIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
