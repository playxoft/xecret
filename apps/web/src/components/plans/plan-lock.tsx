'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import Link from 'next/link';
import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  FocusEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';

import { cn } from '@/lib/cn';
import { isApiError } from '@/lib/api';
import { Alert, DropdownMenuItem, LockIcon } from '@/components/ui';
import { withoutReasonPrefix } from './plan-copy';
import { blockFromRefusal, lockCopy } from './plan-gate';
import type { LockCopy, PlanBlock } from './plan-gate';
import { usePlanView } from './plan-entitlements';

/**
 * A control the organisation's plan does not allow, drawn locked rather than
 * hidden, with a sentence saying what the plan allows and what to do about it.
 *
 * ── Why not a disabled button with a tooltip ──
 * A `disabled` button takes no focus and fires no pointer events, so a tooltip
 * on it can never open, and a keyboard or screen-reader user never learns why
 * it is dead. These stay focusable: the control is marked `aria-disabled`, its
 * own action is cancelled, and it carries the reason in `aria-describedby`.
 *
 * ── Why a popover and not `Tooltip` ──
 * A tooltip does not open on a touch screen and cannot hold a link. This opens
 * on hover, on focus and on a tap, and a tap or Enter pins it open so the
 * owner's "Upgrade" link can be reached: by pointer, or by keyboard, where
 * pinning moves focus into it. Escape, a tap elsewhere or moving focus away
 * closes it.
 *
 * ── Who is told what ──
 * `lockCopy` decides: an owner is offered the organisation's plans page,
 * anybody else is told to ask an owner, and where nothing can be bought only
 * the fact is said.
 */

const LINK =
  'text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4';

/** How long the pointer may be away before a hover-opened lock closes. */
const CLOSE_AFTER_MS = 150;

/** The words of a lock for whoever is looking, from the shell's plan view. */
function useLockCopy(lock: PlanBlock): { copy: LockCopy; plansHref: string } {
  const view = usePlanView();
  const copy = lockCopy(lock, {
    owner: view?.owner ?? false,
    upgrades: view?.entitlements?.upgrades ?? false,
  });
  return { copy, plansHref: view?.plansHref ?? '/pricing' };
}

/** The text a lock reads out, as one string: the fact and the next step. */
function spoken(copy: LockCopy): string {
  return copy.next === null ? copy.reason : `${copy.reason} ${copy.next}`;
}

/**
 * What a lock says: the fact, the next step, and an owner's link.
 *
 * Rendered inside the popover of `LockedAction` and `PlanLockBadge`, and inline
 * by `PlanLockNotice`. Exported so the words can be pinned by a render test.
 */
export function PlanLockContent({
  copy,
  plansHref,
  kind,
}: {
  copy: LockCopy;
  plansHref: string;
  kind: PlanBlock['kind'];
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm leading-5">
      <p className="text-fg">{spoken(copy)}</p>
      {copy.link ? (
        <p>
          <Link href={plansHref} className={LINK}>
            {kind === 'awaiting' ? 'Choose a plan' : 'Upgrade'}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The open state a lock's popover shares between hover, focus and a tap.
 *
 * Hover and focus open it *loosely*: it closes when the pointer or the focus
 * leaves. A click (a tap, Enter, Space) *pins* it, so it stays until it is
 * dismissed, which is what lets a touch user read it and a keyboard user reach
 * the link inside.
 */
function useLockPopover() {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const escaped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = useRef<HTMLDivElement>(null);

  const cancelClose = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    pinned.current = false;
    setOpen(false);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const scheduleClose = useCallback(() => {
    if (pinned.current) return;
    cancelClose();
    timer.current = setTimeout(close, CLOSE_AFTER_MS);
  }, [cancelClose, close]);

  const trigger = {
    onClick: (event: MouseEvent<HTMLElement>) => {
      // The control's own action never runs, and Radix's toggle is skipped:
      // a click here pins the explanation instead.
      event.preventDefault();
      if (pinned.current) {
        close();
        return;
      }
      cancelClose();
      pinned.current = true;
      setOpen(true);
      // From the keyboard (a click with no pointer behind it), focus moves into
      // the panel so its link can be reached. A tap leaves focus where it is.
      if (event.detail === 0) {
        requestAnimationFrame(() =>
          content.current?.querySelector<HTMLElement>('a, button')?.focus(),
        );
      }
    },
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;
      cancelClose();
      setOpen(true);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse') scheduleClose();
    },
    onFocus: () => {
      cancelClose();
      setOpen(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (next !== null && content.current?.contains(next)) return;
      if (!pinned.current) close();
    },
  };

  const panel = {
    onPointerEnter: cancelClose,
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse') scheduleClose();
    },
    // Opened loosely, focus stays on the control; pinned, the click above
    // moves it in itself.
    onOpenAutoFocus: (event: Event) => event.preventDefault(),
    onEscapeKeyDown: () => {
      escaped.current = true;
    },
    // Focus goes back to the control only after Escape. Closed because focus
    // moved on, sending it back would trap the keyboard on the control.
    onCloseAutoFocus: (event: Event) => {
      if (!escaped.current) event.preventDefault();
      escaped.current = false;
    },
  };

  return { open, close, trigger, panel, content };
}

/** The panel a lock opens: its words, beside the control. */
function LockPanel({
  lock,
  panel,
  contentRef,
}: {
  lock: PlanBlock;
  panel: ReturnType<typeof useLockPopover>['panel'];
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const { copy, plansHref } = useLockCopy(lock);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={contentRef}
        side="top"
        align="center"
        sideOffset={6}
        collisionPadding={16}
        onPointerEnter={panel.onPointerEnter}
        onPointerLeave={panel.onPointerLeave}
        onOpenAutoFocus={panel.onOpenAutoFocus}
        onEscapeKeyDown={panel.onEscapeKeyDown}
        onCloseAutoFocus={panel.onCloseAutoFocus}
        className={cn(
          'border-line bg-surface shadow-overlay z-50 max-w-72 rounded-md border px-3 py-2',
          'data-[state=open]:animate-enter data-[state=closed]:animate-exit',
        )}
      >
        <PlanLockContent copy={copy} plansHref={plansHref} kind={lock.kind} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** What `LockedAction` needs of the control it wraps: a `Button`, as a rule. */
interface ActionProps {
  className?: string | undefined;
  children?: ReactNode;
  disabled?: boolean | undefined;
}

/**
 * Wraps a button the plan may block. With no lock it is the button, unchanged;
 * with one, the button gains a lock icon, stays focusable and explains itself
 * instead of acting.
 *
 * ```tsx
 * <LockedAction lock={usePlanLimit('projects', usage?.projects ?? null)}>
 *   <Button variant="primary" onClick={create}>New project</Button>
 * </LockedAction>
 * ```
 */
export function LockedAction({
  lock,
  children,
}: {
  lock: PlanBlock | null;
  children: ReactElement<ActionProps>;
}) {
  if (lock === null) return children;
  return <Locked lock={lock}>{children}</Locked>;
}

function Locked({ lock, children }: { lock: PlanBlock; children: ReactElement<ActionProps> }) {
  const id = useId();
  const { copy } = useLockCopy(lock);
  const { open, close, trigger, panel, content } = useLockPopover();

  const control = cloneElement(children, {
    ...trigger,
    // Focusable on purpose: see the header. The action is cancelled by the
    // click handler, and a submit button no longer submits its form.
    disabled: false,
    type: 'button',
    'aria-disabled': true,
    'aria-describedby': `${id}-why`,
    'data-plan-locked': '',
    className: cn(children.props.className, 'cursor-not-allowed opacity-70'),
    children: (
      <>
        <LockIcon aria-hidden="true" className="size-4 shrink-0" />
        {children.props.children}
      </>
    ),
  } as ActionProps);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <PopoverPrimitive.Trigger asChild>{control}</PopoverPrimitive.Trigger>
      <span id={`${id}-why`} className="sr-only">
        {spoken(copy)}
      </span>
      <LockPanel lock={lock} panel={panel} contentRef={content} />
    </PopoverPrimitive.Root>
  );
}

/**
 * A lock on its own, beside a control that is already disabled for this reason:
 * a switch or a checkbox whose label says what it does. Focusable, named for a
 * screen reader by the lock's words, and opening the same panel on hover, focus
 * or a tap.
 */
export function PlanLockBadge({ lock, className }: { lock: PlanBlock; className?: string }) {
  const { copy } = useLockCopy(lock);
  const { open, close, trigger, panel, content } = useLockPopover();

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          {...trigger}
          aria-label={`Locked. ${spoken(copy)}`}
          data-plan-locked=""
          className={cn(
            'text-fg-subtle hover:text-fg inline-grid size-6 shrink-0 place-items-center rounded-md',
            className,
          )}
        >
          <LockIcon aria-hidden="true" className="size-4" />
        </button>
      </PopoverPrimitive.Trigger>
      <LockPanel lock={lock} panel={panel} contentRef={content} />
    </PopoverPrimitive.Root>
  );
}

/**
 * A menu item the plan may block.
 *
 * A popover inside a menu would fight the menu for focus, so the reason is
 * written into the item itself, on a second line: readable without hover, on
 * any screen. An owner's locked item is the way to the plans page; anybody
 * else's does nothing when chosen, and the line says to ask an owner.
 */
export function LockedMenuItem({
  lock,
  onSelect,
  children,
}: {
  lock: PlanBlock | null;
  onSelect: () => void;
  children: ReactNode;
}) {
  const view = usePlanView();
  if (lock === null) return <DropdownMenuItem onSelect={onSelect}>{children}</DropdownMenuItem>;

  const copy = lockCopy(lock, {
    owner: view?.owner ?? false,
    upgrades: view?.entitlements?.upgrades ?? false,
  });
  const body = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        {children}
        <LockIcon aria-hidden="true" className="text-fg-subtle ml-auto size-3.5 shrink-0" />
      </span>
      <span className="text-fg-subtle text-sm leading-5 whitespace-normal">{spoken(copy)}</span>
    </span>
  );

  if (copy.link) {
    return (
      <DropdownMenuItem asChild data-plan-locked="">
        <Link href={view?.plansHref ?? '/pricing'} className="items-start">
          {body}
        </Link>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      aria-disabled
      data-plan-locked=""
      className="items-start"
      onSelect={(event: Event) => event.preventDefault()}
    >
      {body}
    </DropdownMenuItem>
  );
}

/**
 * A lock said inline, for the one case a lock cannot prevent: the server
 * refusing anyway, because the count moved between the screen reading it and
 * the request landing (two people creating the last project at once). Calm,
 * in the lock's own words rather than the server's longer sentence.
 *
 * Renders nothing for an error that is not a plan refusal, so a form can hand
 * it whatever it caught and show its own message otherwise.
 */
export function PlanLockNotice({ error, lock }: { error?: unknown; lock?: PlanBlock | null }) {
  const block = lock ?? refusalBlock(error);
  if (block === null) return null;
  return <InlineLock lock={block} />;
}

/**
 * A caught failure as the lock it amounts to, or `null` for anything that is
 * not a plan refusal: for a control that should stay locked once the server
 * has said no (an import whose preview was refused).
 */
export function refusalBlock(error: unknown): PlanBlock | null {
  return isApiError(error) && error.code === 'plan_limit' && error.plan !== null
    ? blockFromRefusal(error.plan, withoutReasonPrefix(error.message))
    : null;
}

function InlineLock({ lock }: { lock: PlanBlock }) {
  const { copy, plansHref } = useLockCopy(lock);
  return (
    <Alert tone="info">
      <PlanLockContent copy={copy} plansHref={plansHref} kind={lock.kind} />
    </Alert>
  );
}

/** Whether a caught failure is a plan refusal `PlanLockNotice` will say. */
export function isPlanRefusal(error: unknown): boolean {
  return isApiError(error) && error.code === 'plan_limit' && error.plan !== null;
}
