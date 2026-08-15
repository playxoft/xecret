'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';
import { CheckIcon } from './icons';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'border-line bg-surface shadow-overlay z-50 min-w-52 rounded-lg border p-1',
          'max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const ITEM_BASE =
  'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm ' +
  // Inset ring: the menu clips its overflow, so an outward offset is cut off.
  'focus-visible:outline-offset-[-2px] ' +
  'data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:text-fg-disabled';

export interface DropdownMenuItemProps extends ComponentProps<typeof DropdownMenuPrimitive.Item> {
  /** Destructive items are tinted red and pulled to the bottom of their group. */
  destructive?: boolean;
}

export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        ITEM_BASE,
        destructive
          ? 'text-danger-text data-[highlighted]:bg-danger-tint'
          : 'text-fg-muted data-[highlighted]:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(ITEM_BASE, 'text-fg-muted data-[highlighted]:text-fg pl-8', className)}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="text-accent-text size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('text-fg-subtle px-2 py-1.5 text-sm font-medium', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator className={cn('bg-line my-1 h-px', className)} {...props} />
  );
}
