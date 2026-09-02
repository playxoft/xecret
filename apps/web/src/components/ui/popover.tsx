'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

/**
 * A panel anchored to a control, opened by a click.
 *
 * ── Why this exists next to `DropdownMenu` ──
 * A menu is a list of things you can *do*, and Radix's menu enforces that: it
 * renders `role="menu"`, installs roving focus, and captures printable
 * characters for typeahead. Put a description list inside one and it becomes a
 * menu with no items — invalid ARIA, announced as empty, with arrow keys that
 * do nothing. Panels that carry facts rather than actions belong here.
 *
 * ── And why not `Tooltip` ──
 * A tooltip does not survive on a touch device, vanishes the moment the pointer
 * leaves, and cannot be read at leisure or selected. Anything a person might
 * want to *read* — timestamps, an author, an id — needs a click and a panel that
 * stays put until dismissed.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'border-line bg-surface shadow-overlay z-50 rounded-lg border p-3',
          'max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
