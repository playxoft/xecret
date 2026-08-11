'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { CloseIcon } from './icons';

/**
 * A modal dialog.
 *
 * Radix supplies the parts that are easy to get wrong and invisible when
 * missing: focus moves into the dialog on open and returns to the trigger on
 * close, Tab is trapped inside it, Escape dismisses it, the page behind is
 * scroll-locked, and everything outside is `aria-hidden` so a screen reader
 * cannot wander into content the user cannot reach.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hides the corner dismiss button — for dialogs that require a decision. */
  hideCloseButton?: boolean;
  children?: ReactNode;
}

export function DialogContent({
  className,
  children,
  hideCloseButton = false,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'bg-overlay fixed inset-0 z-50 backdrop-blur-[2px]',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'border-line bg-surface shadow-overlay fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg',
          '-translate-x-1/2 -translate-y-1/2 rounded-xl border',
          // A dialog taller than the viewport scrolls internally; the page
          // behind is locked, so without this its footer becomes unreachable.
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
          className,
        )}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            className="text-fg-subtle hover:bg-surface-hover hover:text-fg absolute top-3.5 right-3.5 grid size-7 place-items-center rounded-md transition-colors"
            aria-label="Close"
          >
            <CloseIcon className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pt-5 pr-12', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-fg text-base font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-fg-muted text-sm leading-6', className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'border-line-subtle flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}
