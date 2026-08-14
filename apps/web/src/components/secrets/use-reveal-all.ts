'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';

/**
 * Revealing every value in an environment at once.
 *
 * ── One request, one audit record ──
 * This calls `GET …/pull?format=json`, which decrypts the whole environment
 * server-side and writes a **single** `secret.read` record carrying the count.
 * The alternative — asking each row to reveal itself — would issue sixty
 * requests and write sixty `secret.revealed` records for one deliberate act,
 * which is worse in both directions at once: slower for the user, and an audit
 * log where one click is indistinguishable from an afternoon of individual
 * reads.
 *
 * ── Why it exists at all ──
 * "Is this the same value as staging?" and "did the import actually land?" are
 * the two questions this screen is opened for, and answering either by revealing
 * eight rows one at a time is the kind of friction people work around by
 * exporting the whole environment to a file — which is strictly worse for the
 * secrets involved.
 *
 * ── The same protections as a single reveal ──
 * The values live in React state only. They are dropped on a timer, when the tab
 * is hidden, when the window loses focus, and on unmount — the same rules
 * `SecretValue` applies to one value, applied to all of them. The window is
 * deliberately shorter than a single reveal's: sixty credentials on screen is a
 * bigger screenshot than one.
 */

/** Shorter than `SecretValue`'s 30s: this is the whole environment, not one row. */
const REVEAL_DURATION_MS = 20_000;

export interface RevealAll {
  /** Name → plaintext while revealed; `null` otherwise. */
  values: Readonly<Record<string, string>> | null;
  revealed: boolean;
  loading: boolean;
  error: string | null;
  secondsLeft: number;
  reveal: () => void;
  hide: () => void;
}

export function useRevealAll(orgSlug: string, projectSlug: string, envSlug: string): RevealAll {
  const [values, setValues] = useState<Readonly<Record<string, string>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const hide = useCallback(() => {
    // Dropping the plaintexts from state is the point: they must not survive in
    // a React fibre for the rest of the page's life, where the next error
    // boundary or dev-tools inspection would surface every one of them.
    setValues(null);
    setSecondsLeft(0);
  }, []);

  // Any change of environment hides immediately. Without this, navigating from
  // dev to production with values on screen would leave dev's plaintexts
  // rendered under production's heading for a frame.
  //
  // Compared during render rather than in an effect, which is React's documented
  // way to adjust state when a prop changes — and here it is the only correct
  // one: an effect runs *after* paint, so the wrong environment's credentials
  // would be on screen for that frame, which is the entire thing being
  // prevented. State, not a ref, because a ref read during render cannot
  // schedule the re-render this needs.
  const path = apiPath.pull(orgSlug, projectSlug, envSlug);
  const [renderedPath, setRenderedPath] = useState(path);
  if (renderedPath !== path) {
    setRenderedPath(path);
    if (values !== null) hide();
  }

  const reveal = useCallback(() => {
    setError(null);
    setLoading(true);

    api
      .get<Record<string, unknown>>(withQuery(path, { format: 'json' }))
      .then((document) => {
        // The pull endpoint answers with a flat `{ NAME: value }` document.
        // Non-string members are dropped rather than coerced: `String(…)` on an
        // unexpected shape would put `[object Object]` in a field people are
        // about to copy into a terminal.
        const plaintexts: Record<string, string> = {};
        for (const [name, value] of Object.entries(document)) {
          if (typeof value === 'string') plaintexts[name] = value;
        }

        setValues(plaintexts);
        setSecondsLeft(Math.ceil(REVEAL_DURATION_MS / 1000));
        setLoading(false);
      })
      .catch(() => {
        // Nothing from the thrown value is kept beyond a fixed string. A failure
        // on this path is a failure to decrypt an environment, and its detail is
        // the server's business — see the note in `lib/api.ts` about bodies.
        setError('Could not reveal these values.');
        setLoading(false);
      });
  }, [path]);

  // Auto-hide. Values left on screen are values in every subsequent screenshot,
  // screen share and shoulder-surf — multiplied by the size of the environment.
  useEffect(() => {
    if (values === null) return;

    // Its own timeout rather than a side effect inside the counter's updater:
    // state updaters must stay pure, and hanging security-relevant behaviour off
    // a once-per-second tick would let a throttled background tab hold sixty
    // credentials on screen indefinitely.
    const hideAt = setTimeout(hide, REVEAL_DURATION_MS);
    const tick = setInterval(() => setSecondsLeft((current) => Math.max(current - 1, 0)), 1000);

    return () => {
      clearTimeout(hideAt);
      clearInterval(tick);
    };
  }, [values, hide]);

  // Hide the moment the tab is hidden or the window loses focus: switching to a
  // call, or starting a screen share, must not leave an environment's worth of
  // credentials visible in a background tab that gets restored later.
  useEffect(() => {
    if (values === null) return;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', hide);
    };
  }, [values, hide]);

  return {
    values,
    revealed: values !== null,
    loading,
    error,
    secondsLeft,
    reveal,
    hide,
  };
}
