'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';

/**
 * One decryption of a whole environment, and the two ways it is shown.
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
 * ── Decrypted once, displayed in two ways ──
 * `reveal` puts every value on screen. `load` performs the same decryption and
 * shows nothing, which is what "Reveal on hover" runs on: the table then
 * un-masks one row at a time as the pointer moves. Both share this cache, so
 * turning hover mode on and then pressing "Reveal all" costs one request, not
 * two, and neither writes a second audit record.
 *
 * ── Masking and forgetting are two different things ──
 * `hide` masks: the plaintexts stay in state and showing them again is free, and
 * that is what the reveal window now does when it ends. They are dropped
 * outright — `forget` — only by the things that make them *wrong*: a write, a
 * delete, a change of environment, unmount, a reload. See `usePlaintextCache`,
 * which holds the per-row decryptions on the same terms. The note in
 * `SecretValue`'s header about what the audit log does and does not claim
 * applies here too.
 */

/**
 * Matches `SecretValue`'s window, so everything on screen masks at one pace.
 *
 * Exported for the table, which masks the rows hover mode stuck open on the same
 * clock — see the note there.
 */
export const REVEAL_DURATION_MS = 180_000;

export interface RevealAll {
  /** Name → plaintext for as long as the window lasts; `null` once dropped. */
  values: Readonly<Record<string, string>> | null;
  /** Whether every value is currently on screen. */
  revealed: boolean;
  loading: boolean;
  error: string | null;
  /** Decrypt if needed, then show everything. */
  reveal: () => void;
  /** Mask everything, keeping the plaintexts for the rest of the window. */
  hide: () => void;
  /** Decrypt if needed and show nothing — for a caller that reveals per row. */
  load: () => void;
  /**
   * Drops the plaintexts outright, so the next reveal is a fresh audited read.
   *
   * Called by every write in the table — a save, a delete, a restore. This
   * cache is a snapshot of an environment, and a snapshot that outlives the
   * environment it describes is worse than no snapshot: the row would keep
   * showing the value that has just been replaced, Copy would put the
   * superseded credential on the clipboard, and the editor — which seeds itself
   * from here — would offer the old value as the basis for the next edit and
   * write it straight back over the new one.
   */
  forget: () => void;
}

export function useRevealAll(orgSlug: string, projectSlug: string, envSlug: string): RevealAll {
  const [values, setValues] = useState<Readonly<Record<string, string>> | null>(null);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = apiPath.pull(orgSlug, projectSlug, envSlug);

  const hide = useCallback(() => setShown(false), []);

  const forget = useCallback(() => {
    // Dropping the plaintexts from state is the point: they must not survive in
    // a React fibre for the rest of the page's life, where the next error
    // boundary or dev-tools inspection would surface every one of them.
    setValues(null);
    setShown(false);
  }, []);

  // Any change of environment forgets immediately. Without this, navigating from
  // dev to production with values on screen would leave dev's plaintexts
  // rendered under production's heading for a frame.
  //
  // Compared during render rather than in an effect, which is React's documented
  // way to adjust state when a prop changes — and here it is the only correct
  // one: an effect runs *after* paint, so the wrong environment's credentials
  // would be on screen for that frame, which is the entire thing being
  // prevented. State, not a ref, because a ref read during render cannot
  // schedule the re-render this needs.
  const [renderedPath, setRenderedPath] = useState(path);
  if (renderedPath !== path) {
    setRenderedPath(path);
    if (values !== null) forget();
  }

  // The request in flight, so a second click cannot start a second decryption
  // of the same environment, and so a response for the environment the user has
  // just navigated away from is discarded rather than shown under the new one.
  const inFlight = useRef<AbortController | null>(null);
  const showWhenLoaded = useRef(false);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
      setLoading(false);
    },
    [path],
  );

  const request = useCallback(
    (show: boolean) => {
      setError(null);

      if (values !== null) {
        if (show) setShown(true);
        return;
      }

      if (inFlight.current !== null) {
        // "Reveal all" pressed while hover mode's silent load is still out:
        // upgrade that request rather than issuing another one.
        if (show) showWhenLoaded.current = true;
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      showWhenLoaded.current = show;
      setLoading(true);

      api
        .get<Record<string, unknown>>(withQuery(path, { format: 'json' }), {
          signal: controller.signal,
        })
        .then((document) => {
          if (controller.signal.aborted) return;

          // The pull endpoint answers with a flat `{ NAME: value }` document.
          // Non-string members are dropped rather than coerced: `String(…)` on an
          // unexpected shape would put `[object Object]` in a field people are
          // about to copy into a terminal.
          const plaintexts: Record<string, string> = {};
          for (const [name, value] of Object.entries(document)) {
            if (typeof value === 'string') plaintexts[name] = value;
          }

          setValues(plaintexts);
          setShown(showWhenLoaded.current);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Nothing from the thrown value is kept beyond a fixed string. A failure
          // on this path is a failure to decrypt an environment, and its detail is
          // the server's business — see the note in `lib/api.ts` about bodies.
          setError('Could not reveal these values.');
          setLoading(false);
        })
        .finally(() => {
          if (inFlight.current === controller) inFlight.current = null;
        });
    },
    [path, values],
  );

  const reveal = useCallback(() => request(true), [request]);
  const load = useCallback(() => request(false), [request]);

  // The end of the window masks; it does not drop the decryption. The two are
  // different acts — see `usePlaintextCache` — and only masking is about what
  // can be read off an unattended screen. Pressing "Reveal all" again after the
  // window lapses is then instant and writes no second `secret.read` record,
  // while everything that makes this snapshot *wrong* still calls `forget`.
  //
  // Counted from the decryption rather than from the last time the values
  // happened to be on screen.
  useEffect(() => {
    if (values === null || !shown) return;

    const maskAt = setTimeout(hide, REVEAL_DURATION_MS);
    return () => clearTimeout(maskAt);
  }, [values, shown, hide]);

  // Mask the moment the tab is hidden: starting a screen share must not leave an
  // environment's worth of credentials visible in a background tab that gets
  // restored later. Only `visibilitychange` — see the note in `SecretValue`
  // about why `blur` is not in this list.
  useEffect(() => {
    if (!shown) return;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [shown, hide]);

  return {
    values,
    revealed: shown && values !== null,
    loading,
    error,
    reveal,
    hide,
    load,
    forget,
  };
}
