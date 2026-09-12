'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Turns "there is another page" into "fetch it when the reader gets near the
 * end", for the two long lists in the dashboard: the audit log and the secret
 * table.
 *
 * The caller keeps every piece of state it already had — the cursor, the
 * accumulated rows, the in-flight flag — and only swaps the button for the
 * sentinel this hook watches. Nothing here knows how a page is fetched.
 *
 * ── Why the observer is rebuilt rather than left running ──
 * `IntersectionObserver` reports *changes*. A sentinel that is still on screen
 * after a page lands produces no second callback, so a short page — or a tall
 * viewport that swallows twenty rows — would stall with the sentinel sitting in
 * view and nothing asking for more. Re-subscribing whenever `loading` or
 * `hasMore` changes gives each new observer an initial callback with the current
 * state, which continues the chain exactly as far as the viewport needs and
 * stops the moment the sentinel is pushed off it.
 *
 * @param onLoadMore Fetches the next page. Held in a ref, so a caller may pass
 *   a fresh closure every render without re-subscribing the observer.
 * @param hasMore False at the end of the list, which stops the watching.
 * @param loading True while a page is in flight. Guards against a second
 *   request for the same page when the sentinel is already on screen.
 * @param rootMargin How early to ask, expressed as a band below the viewport.
 *   Defaults to most of a screen, so the rows are usually there before the
 *   reader arrives at the gap.
 * @returns The ref to put on an element at the end of the list. It must be
 *   rendered whenever `hasMore` is true — an element that is not in the
 *   document cannot be observed.
 */
export function useInfiniteScroll<T extends HTMLElement = HTMLDivElement>({
  onLoadMore,
  hasMore,
  loading,
  rootMargin = '400px 0px',
}: {
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  rootMargin?: string;
}): RefObject<T | null> {
  const sentinel = useRef<T | null>(null);

  const latest = useRef(onLoadMore);
  useEffect(() => {
    latest.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = sentinel.current;
    if (element === null || !hasMore || loading) return;

    // No observer — older Safari, jsdom, anything headless. Deliberately *not*
    // the "call straight through" fallback `observeOnce` uses: calling through
    // here would fetch every page in the list back to back, as fast as the API
    // would answer. The callers render a button in this case instead, which is
    // the honest version of the same offer. See `infiniteScrollSupported`.
    if (typeof IntersectionObserver !== 'function') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, rootMargin]);

  return sentinel;
}

/**
 * Whether this browser can do the watching at all.
 *
 * The callers keep a "Load more" button for the one that cannot, rather than
 * ending the list at whatever the first page happened to hold — which would be
 * a silent loss of half the log. Safe to read during render in both callers:
 * their lists exist only after a client-side fetch, so there is no server-
 * rendered markup for the answer to disagree with.
 */
export function infiniteScrollSupported(): boolean {
  return typeof IntersectionObserver === 'function';
}
