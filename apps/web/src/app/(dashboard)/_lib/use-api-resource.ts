'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';

/**
 * A GET, its outcome, and a way to run it again.
 *
 * The dashboard reads its data from the browser, not from a Server Component.
 * That is a consequence of the session being a `__Host-` cookie the API
 * validates on every call: rendering a page on the server would mean either
 * forwarding that cookie into a second internal request, or teaching the page a
 * second way to authenticate. One authenticated client, used from one place, is
 * what makes "every request carries CSRF and handles a 401 the same way" true —
 * see the header of `lib/api.ts`.
 *
 * The cost is a loading state on every screen, which is why the pages that use
 * this render skeletons rather than a spinner.
 */
export interface ApiResource<T> {
  data: T | null;
  /** An `ApiError` in every case the server answered. Read it with `isApiError`. */
  error: unknown;
  loading: boolean;
  /**
   * Re-runs the request, keeping the current data on screen until it resolves.
   *
   * ── Why this is awaitable ──
   * A caller that navigates after a reload has to know when the new answer has
   * landed, and "it will land eventually" is not enough. Deleting an
   * organisation is the case that proved it: the delete card refreshed the
   * session and then `router.replace`d to `/app`, which reads the membership
   * list to decide where to send a viewer — and read the copy that still
   * contained the organisation that had just been deleted, so an owner who
   * closed their only organisation was redirected straight into its 404.
   *
   * Ignoring the promise is still perfectly correct for a retry button, and
   * every such caller does.
   *
   * ── What "resolved" means, precisely ──
   * That the response has been handed to `setState` — not that React has
   * rendered with it. The continuation of an `await` is a microtask and React's
   * flush is not, so an awaiting caller runs *before* anything re-renders. The
   * navigating callers are correct regardless, but for a more specific reason
   * than "the new answer is in state": the update is already queued when they
   * call `router.push`, so the render that the navigation itself triggers
   * carries it. What a caller cannot do is read `data` off this hook straight
   * after the `await` and expect the new value — that is the render it has not
   * had yet.
   *
   * It also resolves *without* an answer in the three cases where one is never
   * coming: the hook unmounts, its `path` becomes `null`, or the request fails.
   * A promise that can never settle strands the `await` behind it for the life
   * of the page, which is a worse failure than an early "no".
   */
  reload: () => Promise<void>;
}

interface ResourceState<T> {
  /** The path this outcome describes. `null` until the first response lands. */
  path: string | null;
  data: T | null;
  error: unknown;
}

/**
 * @param path An API path, or `null` to fetch nothing — for a resource whose
 *   address is not known yet, where the alternative is a request to `/undefined`.
 */
export function useApiResource<T>(path: string | null): ApiResource<T> {
  const [state, setState] = useState<ResourceState<T>>({ path: null, data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);

  /**
   * Callers awaiting a reload they asked for, each tagged with the attempt it
   * asked about.
   *
   * A ref rather than state, because nothing renders differently for a pending
   * await and a `setState` here would cost a second render per reload. The tag
   * is what makes it correct: `reload` bumps the counter and the effect re-runs
   * a tick later, so an untagged list would be emptied by the *previous*
   * attempt's response — resolving the caller against the very data it asked to
   * have replaced.
   */
  const waiting = useRef<{ attempt: number; resolve: () => void }[]>([]);
  const nextAttempt = useRef(0);

  const settle = useCallback((completed: number) => {
    const pending = waiting.current;
    waiting.current = pending.filter((waiter) => waiter.attempt > completed);
    for (const waiter of pending) {
      if (waiter.attempt <= completed) waiter.resolve();
    }
  }, []);

  useEffect(() => {
    // A resource with no address has nothing to re-read, so anyone awaiting a
    // reload of one is released rather than left holding a promise that can
    // never settle.
    if (path === null) {
      settle(attempt);
      return;
    }

    const controller = new AbortController();

    // Nothing is written to state here, only in the callbacks below. Clearing
    // the previous result up front would be a synchronous setState inside an
    // effect — a cascading render — and it is not needed: the result carries the
    // path it belongs to, and a result for a different path is treated as absent
    // by the derivation at the bottom of this hook. That is also what stops one
    // environment's secrets appearing for a moment under another environment's
    // heading.
    api
      .get<T>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ path, data, error: null });
        setReloading(false);
        settle(attempt);
      })
      .catch((cause: unknown) => {
        // An abort is this effect cleaning up after itself, not a failure the
        // user should be told about.
        if (controller.signal.aborted) return;
        setState({ path, data: null, error: cause });
        setReloading(false);
        // A failed refresh settles its waiters too. They asked "is the answer
        // current yet", and "the server would not say" is an answer — leaving
        // them holding an unresolved promise would strand a caller half way
        // through a navigation, with nothing on screen to explain why.
        settle(attempt);
      });

    return () => controller.abort();
  }, [path, attempt, settle]);

  /**
   * Releases anyone still awaiting a reload when the hook goes away.
   *
   * The effect above aborts its request on cleanup, and both of its callbacks
   * return early on an aborted signal — before reaching `settle`. That is right
   * for an abort caused by a *new* attempt, whose own response settles the
   * earlier waiters along with its own. It is wrong for the last one: unmount
   * this hook with a caller mid-`await` and that promise can never settle, so
   * the continuation after it never runs and the caller is left half way through
   * whatever it was doing, with nothing on screen to say why.
   *
   * `nextAttempt.current` is read at cleanup rather than captured, so it is the
   * highest attempt anyone ever asked about — every waiter is at or below it.
   * Empty deps, so this runs on unmount only and never between attempts, where
   * settling early is exactly the bug the attempt tag exists to prevent.
   */
  useEffect(() => {
    return () => settle(nextAttempt.current);
  }, [settle]);

  const reload = useCallback(() => {
    // Set from an event handler rather than from the effect, which is why this
    // is allowed to exist at all: it is what gives a retry button something
    // visible to do while the previous result stays on screen.
    setReloading(true);

    // Tracked in a ref as well as in state because the promise has to be tagged
    // with the attempt now, and `attempt` will not hold the new value until the
    // render this call schedules.
    nextAttempt.current += 1;
    const target = nextAttempt.current;
    setAttempt(target);

    return new Promise<void>((resolve) => {
      waiting.current.push({ attempt: target, resolve });
    });
  }, []);

  const describesCurrentPath = state.path === path;

  return {
    data: describesCurrentPath ? state.data : null,
    error: describesCurrentPath ? state.error : null,
    loading: path !== null && (!describesCurrentPath || reloading),
    reload,
  };
}
