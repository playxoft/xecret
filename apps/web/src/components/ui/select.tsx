'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';
import { useFieldControl } from './field';
import { CheckIcon, ChevronDownIcon } from './icons';

/**
 * Radix Select rather than a native `<select>`.
 *
 * The trade is deliberate: native selects cannot render the environment
 * badges and secondary text these menus need, but they come with correct
 * keyboard and mobile behaviour for free. Radix reimplements typeahead, arrow
 * keys, Home/End, Escape, and the ARIA listbox pattern, which is why this
 * wraps it rather than a `<div role="listbox">`.
 */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  const fieldProps = useFieldControl();

  return (
    <SelectPrimitive.Trigger
      {...fieldProps}
      className={cn(
        'border-line-strong bg-canvas-inset text-fg flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 text-sm',
        'transition-colors duration-150',
        'hover:enabled:border-fg-subtle',
        'data-[state=open]:border-accent',
        'aria-[invalid=true]:border-danger',
        'disabled:text-fg-disabled disabled:cursor-not-allowed',
        // Radix renders the placeholder inside the value node; target it so
        // an empty select reads as a prompt rather than as a chosen value.
        'data-[placeholder]:text-fg-subtle',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-fg-subtle size-4 shrink-0" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        className={cn(
          'border-line bg-surface shadow-overlay z-50 min-w-[var(--radix-select-trigger-width)] rounded-lg border p-1',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
          // Never taller than the viewport, and scrollable inside — a long
          // list (the audit log's action filter is thirty entries) must not
          // clip its tail behind an `overflow-hidden` nobody can get past.
          // The content itself scrolls, so the scrollbar is visible; Radix's
          // own Viewport hides its scrollbar by design, which without the
          // arrow buttons left long menus with no way to reach the rest.
          'max-h-[min(24rem,var(--radix-select-content-available-height))] overflow-x-hidden overflow-y-auto',
          className,
        )}
        {...props}
      >
        <SelectScrollButton direction="up" />
        <SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
        <SelectScrollButton direction="down" />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/**
 * The keyboard-free way through a long list: Radix renders these only while
 * more items exist in that direction, so they double as the "there is more"
 * affordance a clipped menu was silently missing.
 */
function SelectScrollButton({ direction }: { direction: 'up' | 'down' }) {
  const Component =
    direction === 'up' ? SelectPrimitive.ScrollUpButton : SelectPrimitive.ScrollDownButton;

  return (
    <Component className="text-fg-subtle bg-surface sticky z-10 flex h-6 cursor-default items-center justify-center">
      <ChevronDownIcon className={cn('size-4', direction === 'up' && 'rotate-180')} />
    </Component>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'text-fg relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm select-none',
        // Drawn inside the item: the popover clips its own overflow, so an
        // outward-offset ring would be cut off on the left and right edges.
        'focus-visible:outline-offset-[-2px]',
        'data-[highlighted]:bg-surface-hover',
        'data-[disabled]:text-fg-disabled data-[disabled]:pointer-events-none',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="text-accent-text size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('text-fg-subtle px-2 py-1.5 text-sm font-medium', className)}
      {...props}
    />
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('bg-line my-1 h-px', className)} {...props} />;
}
