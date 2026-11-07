'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface FileDropZoneProps {
  /** Every file dropped on the zone, in the order the browser lists them. */
  onFiles: (files: File[]) => void;
  /**
   * While true the zone draws no invitation and hands nothing on. A drop is
   * still taken — so it never reaches the browser — and ignored.
   */
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Whether a drag carries files, rather than only text or a link. */
export function carriesFiles(types: readonly string[] | null | undefined): boolean {
  return types?.includes('Files') ?? false;
}

/**
 * How deep inside the zone a drag is, after one more event. Pure, so the rule
 * can be pinned without a DOM.
 *
 * A drag crossing from the zone onto one of its own children fires `dragenter`
 * on the child before `dragleave` on the zone, so a zone that untinted on every
 * `dragleave` flickered all the way across its own text and button. Counting
 * entries against exits untints only when the drag has left all of them.
 */
export function nextDragDepth(depth: number, event: 'dragenter' | 'dragleave' | 'drop'): number {
  switch (event) {
    case 'dragenter':
      return depth + 1;
    case 'dragleave':
      return Math.max(0, depth - 1);
    case 'drop':
      return 0;
  }
}

/** The parts of a window-level drag event the guard reads and writes. */
export type GuardedDragEvent = Pick<
  DragEvent,
  'type' | 'defaultPrevented' | 'dataTransfer' | 'preventDefault'
>;

/**
 * What `useFileDropGuard` does with one `dragover` or `drop` that reached the
 * window. Pure, so the rule can be pinned without a DOM.
 *
 * Only a drag carrying files is touched, so text dragged into a field anywhere
 * on the page still lands there. One something nearer already took — the drop
 * zone, which cancels every drag over it — is left alone. Any other is
 * cancelled, which is what stops the browser opening the file in the tab, and
 * over it the cursor says no drop is possible here.
 */
export function guardFileDrag(event: GuardedDragEvent): void {
  if (event.defaultPrevented || !carriesFiles(event.dataTransfer?.types)) return;
  event.preventDefault();
  if (event.type === 'dragover' && event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = 'none';
  }
}

/**
 * Keeps a file dropped anywhere on the page from being opened in the tab, for
 * as long as `active` — an import dialog's `open`.
 *
 * A file dropped where no handler takes it is opened by the browser in place
 * of the page, which would throw away the dialog and everything it had read —
 * on an archive import, the opened archive and the unlocked vault with it. A
 * drop zone takes what is dropped on it; this covers the rest of the page for
 * every step of the dialog, not only the one that draws the zone: a second
 * part dropped onto the preview, or onto the dialog's header, its footer or
 * its overlay, is ignored. The listeners are removed when the dialog closes or
 * unmounts.
 */
export function useFileDropGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('dragover', guardFileDrag);
    window.addEventListener('drop', guardFileDrag);
    return () => {
      window.removeEventListener('dragover', guardFileDrag);
      window.removeEventListener('drop', guardFileDrag);
    };
  }, [active]);
}

/**
 * A dashed panel that takes a dropped file — the file step of an import.
 *
 * Its children are the rest of that step, and they must include a keyboard
 * path: dropping is a pointer-only interaction, so each import draws a "Choose
 * a file" Button beside its hidden file input. The dialog around it mounts
 * `useFileDropGuard`, for a file dropped anywhere else.
 *
 * Every drag over the zone is cancelled, not only one carrying files: a link —
 * or a webmail attachment that is dragged as one — dropped here would
 * otherwise be followed by the browser, and the zone is never a place to drop
 * text. Only files tint it, and only files are handed on.
 */
export function FileDropZone({
  onFiles,
  disabled = false,
  className,
  children,
}: FileDropZoneProps) {
  const [over, setOver] = useState(false);
  // A ref, not state: it changes on every element crossed, and only the moment
  // it reaches zero is worth a render. It starts at zero with each zone, so a
  // drag cut off by the zone unmounting cannot leave the next zone tinted.
  const depth = useRef(0);

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        if (!carriesFiles(event.dataTransfer.types)) return;
        depth.current = nextDragDepth(depth.current, 'dragenter');
        setOver(true);
      }}
      // Cancelling `dragover` is what makes this element a drop target.
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!carriesFiles(event.dataTransfer.types)) return;
        depth.current = nextDragDepth(depth.current, 'dragleave');
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = nextDragDepth(depth.current, 'drop');
        setOver(false);
        if (!disabled && carriesFiles(event.dataTransfer.types)) {
          onFiles(Array.from(event.dataTransfer.files));
        }
      }}
      className={cn(
        'rounded-xl border border-dashed px-4 py-6 text-center transition-colors',
        over && !disabled ? 'border-accent bg-accent-tint' : 'border-line bg-canvas-inset',
        className,
      )}
    >
      {children}
    </div>
  );
}
