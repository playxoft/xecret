'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/**
 * The height of the sticky settings header, in pixels, published to everything
 * that has to stay clear of it.
 *
 * Three things need this number and none of them can be told it at build time:
 * the contents rail parks underneath the header, an anchor jump has to land
 * below it rather than behind it, and the rail's active-section band starts at
 * its lower edge. The header's own height is not a constant — the description
 * rewraps, the tab strip wraps on a narrow viewport — so it is measured.
 *
 * A store rather than state lifted into the layout, because the layout is a
 * Server Component and the two readers are siblings of the writer, not
 * descendants. `useSyncExternalStore` is how the rail subscribes; the CSS
 * custom property below is how the stylesheet reads the same number.
 */
const listeners = new Set<() => void>();
let headerHeight = 0;

function publishHeaderHeight(next: number): void {
  if (next === headerHeight) return;
  headerHeight = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return headerHeight;
}

/** `0` on the server, where nothing has been measured and nothing is sticky. */
function serverSnapshot(): number {
  return 0;
}

export function useSettingsHeaderHeight(): number {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * The same measurement, for the stylesheet.
 *
 * `globals.css` gives `[data-settings-section]` a `scroll-margin-top` built
 * from this, which is what makes a direct visit to `…/security#devices` — no
 * JavaScript of ours involved in the jump — land with the heading visible.
 * Written on `:root` because that is the one element every section on the page
 * inherits from, and there is only ever one settings screen mounted.
 */
const HEIGHT_VARIABLE = '--settings-header-height';

/**
 * The settings area's heading and tab strip, pinned below the application's top
 * bar.
 *
 * Sticky rather than scrolling away with the content: the tab strip is how you
 * get from Security to Danger zone, and on a tab two or three screens long it
 * used to be somewhere above you. Keeping it in place also keeps the answer to
 * "where am I?" on screen, which is the job a secondary nav exists to do.
 *
 * `top` is the top bar's height, not `0`: the bar is sticky too and sits a
 * stacking level above this, so a header parked at `0` would slide underneath it
 * and be legible only through its blur. `z-20` for the same reason — above the
 * cards that pass beneath it, below the bar that owns the viewport's top edge.
 */
export function SettingsHeader({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    // `ResizeObserver` rather than a one-off measurement: the height changes
    // when the viewport width rewraps the description or the tab strip, and a
    // number measured once would leave every anchor jump landing a line or two
    // off for the rest of the session.
    const observer = new ResizeObserver(() => {
      const height = node.offsetHeight;
      publishHeaderHeight(height);
      document.documentElement.style.setProperty(HEIGHT_VARIABLE, `${height}px`);
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      publishHeaderHeight(0);
      // Removed on the way out, so a page outside this layout does not inherit
      // an offset for a header that is no longer on screen.
      document.documentElement.style.removeProperty(HEIGHT_VARIABLE);
    };
  }, []);

  return (
    <div
      ref={ref}
      // The negative insets let the background reach past the reading column,
      // so a card scrolling underneath is covered rather than peeking out at
      // the sides. They cancel the padding `AppShell` puts on `<main>`, which
      // is what keeps this from being horizontal overflow.
      className="bg-canvas/95 sticky top-[var(--topbar-height)] z-20 -mx-4 flex flex-col gap-4 px-4 pt-1 pb-4 backdrop-blur-sm sm:-mx-6 sm:px-6"
    >
      {children}
    </div>
  );
}
