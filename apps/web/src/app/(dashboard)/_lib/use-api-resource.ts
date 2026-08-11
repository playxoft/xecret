'use client';

import { useCallback, useEffect, useState } from 'react';

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
  /** Re-runs the request, keeping the current data on screen until it resolves. */
  reload: () => void;
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

  useEffect(() => {
    if (path === null) return;

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
      })
      .catch((cause: unknown) => {
        // An abort is this effect cleaning up after itself, not a failure the
        // user should be told about.
        if (controller.signal.aborted) return;
        setState({ path, data: null, error: cause });
        setReloading(false);
      });

    return () => controller.abort();
  }, [path, attempt]);

  const reload = useCallback(() => {
    // Set from an event handler rather than from the effect, which is why this
    // is allowed to exist at all: it is what gives a retry button something
    // visible to do while the previous result stays on screen.
    setReloading(true);
    setAttempt((current) => current + 1);
  }, []);

  const describesCurrentPath = state.path === path;

  return {
    data: describesCurrentPath ? state.data : null,
    error: describesCurrentPath ? state.error : null,
    loading: path !== null && (!describesCurrentPath || reloading),
    reload,
  };
}
