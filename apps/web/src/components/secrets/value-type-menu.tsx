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
 * ── Why it is this small ──
 * It renders as the type's name in the corner of the value cell, at the size of
 * a caption. The overwhelming majority of secrets are opaque strings and will
 * never be typed at all, so the control has to be invisible until wanted — a
 * full-width `<Select>` on every row would make the table about types, which it
 * is not.
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
          // The open state carries the hover foreground as well as the hover
          // fill. Opened from the keyboard there is no pointer to supply the
          // second half, and `--fg-subtle` on `--surface-hover` measures
          // 4.38:1 in dark — under AA for 14px text, and under it only in the
          // state where the menu is demanding attention.
          'text-fg-subtle hover:text-fg hover:bg-surface-hover data-[state=open]:text-fg data-[state=open]:bg-surface-hover -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-sm transition-colors',
          'disabled:pointer-events-none disabled:opacity-60',
          // The default is quieter than a chosen one: a row somebody has
          // deliberately typed should be findable by eye down the column.
          current !== 'string' && 'text-accent-text font-medium',
          className,
        )}
      >
        {descriptor.label}
        <ChevronDownIcon aria-hidden="true" className="size-3" />
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
