'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

import { cn } from '@/lib/cn';

/**
 * Scroll-triggered entrance, for the public pages only.
 *
 * The component does almost nothing: it observes intersection and sets
 * `data-shown`. Every value that decides how the element moves — distance,
 * duration, easing, the stagger ramp — lives in `globals.css` beside the rest
 * of the design system, because motion is a design decision and not a prop.
 *
 * ── Why an observer rather than a scroll listener ──
 * A `scroll` handler runs on the main thread on every frame of every scroll,
 * for every element it watches. `IntersectionObserver` is the platform's answer
 * to exactly this, it batches off the main thread, and it fires once for
 * elements already on screen at load — which is the case that hand-rolled
 * scroll maths always gets wrong.
 *
 * ── Why it unobserves ──
 * Content does not re-hide when it leaves the viewport. An element that fades
 * out as you scroll back up is a page that fights the reader, and re-running
 * the animation on every pass is motion for its own sake.
 */
function useReveal(): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Older Safari and any headless environment without the API: show the
    // content immediately rather than leaving it at `opacity: 0` forever.
    // A missing animation is a missing animation; missing content is a bug.
    if (typeof IntersectionObserver !== 'function') {
      element.dataset['shown'] = 'true';
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset['shown'] = 'true';
          observer.unobserve(entry.target);
        }
      },
      // Deliberately eager. `threshold: 0` fires the instant one pixel of the
      // element crosses the boundary, and the positive bottom `rootMargin`
      // starts it 80px *before* the viewport edge — so a section is already
      // animating by the time it is on screen, rather than sitting blank for
      // half a second while the reader waits for it. Overshooting the other
      // way is the classic scroll-animation defect: content that reveals
      // itself only after you have looked straight at it.
      { threshold: 0, rootMargin: '0px 0px 80px 0px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return ref;
}

export interface RevealProps {
  /** Milliseconds to hold before this element moves. */
  delay?: number;
  className?: string;
  children: ReactNode;
}

/** One element that lifts into place when it is scrolled to. */
export function Reveal({ delay = 0, className, children }: RevealProps) {
  const ref = useReveal();

  return (
    <div
      ref={ref}
      className={cn('x-reveal', className)}
      // The only inline style here, and only when it is not the default: the
      // rest of the animation is a class.
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/**
 * A container whose direct children arrive in sequence.
 *
 * One observer for a whole row of cards rather than one per card — see the
 * `.x-reveal-group` rules in `globals.css` for why the stagger belongs to the
 * group and not to each tile.
 */
export function RevealGroup({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useReveal();

  return (
    <div ref={ref} className={cn('x-reveal-group', className)}>
      {children}
    </div>
  );
}
