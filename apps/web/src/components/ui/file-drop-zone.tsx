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

/**
 * Whether a drag carries files. Text or a link dragged across the zone is not
 * an offer of a file, so it neither tints the zone nor is taken by it.
 */
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

/**
 * A dashed panel that takes a dropped file — the file step of an import.
 *
 * Its children are the rest of that step, and they must include a keyboard
 * path: dropping is a pointer-only interaction, so each import draws a "Choose
 * a file" Button beside its hidden file input.
 *
 * ── A file dropped beside the zone ──
 * A file dropped where no handler takes it is opened by the browser in the
 * tab, which here would throw away the dialog and whatever it had read. So
 * while a zone is on screen, a file dropped anywhere else in the page — the
 * dialog's header or footer, its overlay — is taken and ignored. Only a drag
 * that carries files is touched, so dragging text into a field still works.
 * The guard lives exactly as long as the zone: it is removed when the zone
 * unmounts, whether the step moves on or the dialog closes.
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

  useEffect(() => {
    function guard(event: DragEvent) {
      if (carriesFiles(event.dataTransfer?.types)) event.preventDefault();
    }
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  return (
    <div
      onDragEnter={(event) => {
        if (!carriesFiles(event.dataTransfer.types)) return;
        event.preventDefault();
        depth.current = nextDragDepth(depth.current, 'dragenter');
        setOver(true);
      }}
      onDragOver={(event) => {
        // Cancelling `dragover` is what makes this element a drop target.
        if (carriesFiles(event.dataTransfer.types)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event.dataTransfer.types)) return;
        depth.current = nextDragDepth(depth.current, 'dragleave');
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event.dataTransfer.types)) return;
        event.preventDefault();
        depth.current = nextDragDepth(depth.current, 'drop');
        setOver(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
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
