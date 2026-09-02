'use client';

import {
  SECRET_VALUE_TYPE_DESCRIPTORS,
  SECRET_VALUE_TYPE_ORDER,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { cn } from '@/lib/cn';
import {
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui';

/**
 * The type picker on a secret row.
 *
 * ── Why it looks like a button ──
 * It used to be bare text with a chevron after it, which reads as a label that
 * happens to have an arrow — so the thing you can *do* here (change the declared
 * type) was invisible until somebody clicked it by accident. It carries its own
 * outline and fill now: a small, quiet, unmistakable button, sized to sit on the
 * same line as the key beside it. Still not a full-width `<Select>` on every
 * row, which would make the table about types, which it is not.
 *
 * ── Why the colour changes with the type ──
 * `string` is the default and accepts anything, so it is drawn in the neutral
 * control colours — an outline saying "this can be changed" and nothing more. A
 * type somebody deliberately chose is drawn in the accent, because the useful
 * question down this column is "which of these are actually checked?", and that
 * has to be answerable by eye rather than by reading sixty labels.
 *
 * ── Why the default reads as "string" rather than as blank ──
 * A blank would suggest the type is unset and might be filled in later. It is
 * not: `string` is a real type that accepts anything, every existing secret has
 * it, and saying so is what makes "why is my value not being checked?" a
 * question with a visible answer.
 */

export interface ValueTypeMenuProps {
  /** The stored type. Anything unrecognised degrades to `string`. */
  value: string;
  onChange: (next: SecretValueType) => void;
  disabled?: boolean;
  /** Names the control for a screen reader — the row's secret name. */
  secretName: string;
  className?: string;
}

export function ValueTypeMenu({
  value,
  onChange,
  disabled = false,
  secretName,
  className,
}: ValueTypeMenuProps) {
  const current = toSecretValueType(value);
  const descriptor = SECRET_VALUE_TYPE_DESCRIPTORS[current];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Value type for ${secretName}: ${descriptor.label}`}
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border px-2 text-sm font-medium transition-colors',
          'disabled:pointer-events-none disabled:opacity-60',
          current === 'string'
            ? // The neutral control colours, matching the well the key input
              // gets on hover — the two sit on one line and must read as one
              // row of controls rather than as two unrelated things.
              cn(
                'border-line-control bg-canvas-inset text-fg-muted',
                'hover:border-fg-subtle hover:text-fg',
                // The open state carries the hover treatment: opened from the
                // keyboard there is no pointer to supply it, and the control
                // demanding attention is the one state where it must not be the
                // quietest thing on the row.
                'data-[state=open]:border-fg-subtle data-[state=open]:text-fg',
              )
            : cn(
                'border-accent-line bg-accent-tint text-accent-text',
                'hover:border-accent hover:bg-accent-tint',
                'data-[state=open]:border-accent',
              ),
          className,
        )}
      >
        {/* Truncated, because the control is given a fixed width by the row —
            "Date and time" is twice the length of "URL" and a column that
            resizes per row is a column nobody can scan. */}
        <span className="truncate">{descriptor.label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>Value type</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => onChange(toSecretValueType(next))}
        >
          {SECRET_VALUE_TYPE_ORDER.map((type) => (
            <DropdownMenuRadioItem key={type} value={type}>
              {SECRET_VALUE_TYPE_DESCRIPTORS[type].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="text-fg-subtle border-line-subtle mt-1 border-t px-2 pt-2 pb-1 text-sm leading-5">
          {descriptor.hint}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
