'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SecretIo } from '@/components/envkeys';

/**
 * One decryption of a whole environment, and the two ways it is shown.
 *
 * ── One request, one audit record ──
 * This calls `SecretIo.pull`, which is `GET …/pull` in both modes and writes a
 * **single** `secret.read` record carrying the count. The alternative — asking
 * each row to reveal itself — would issue sixty requests and write sixty
 * `secret.revealed` records for one deliberate act, which is worse in both
 * directions at once: slower for the user, and an audit log where one click is
 * indistinguishable from an afternoon of individual reads.
 *
 * ── Which mode this is ──
 * Neither, as far as this file is concerned. In `server` mode the pull returns a
 * flat `{ NAME: value }` document the Worker decrypted; in `e2ee` mode it
 * returns the caller's grant alongside every ciphertext, and `SecretIo` opens
 * them here in the browser. Both end as the same map, and the reveal window, the
 * masking and the forgetting below are identical — which is the point of routing
 * through the IO rather than branching in the table.
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

export function useRevealAll(
  orgSlug: string,
  projectSlug: string,
  envSlug: string,
  io: SecretIo | null,
): RevealAll {
  const [values, setValues] = useState<Readonly<Record<string, string>> | null>(null);
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identifies the environment, and only the environment — it is the slugs and
  // nothing else, so a rotation does not change it.
  //
  // That is worth stating because this comment used to claim the opposite: that
  // the guard below dropped a snapshot decrypted under a retired key, because
  // `io` is rebuilt when the key changes. It is not what happens. Nothing here
  // watches `io`, and a rotation leaves this cache exactly as it was. What
  // actually drops a stale snapshot is `forget`, called by every write the table
  // performs and by the `externalWrites` counter the screen threads through it —
  // and the `[path]` comparison covers the different case it was written for,
  // which is navigating from dev to production with values on screen.
  const path = `${orgSlug}/${projectSlug}/${envSlug}`;

  // The request in flight, so a second click cannot start a second decryption
  // of the same environment, and so a response for the environment the user has
  // just navigated away from is discarded rather than shown under the new one.
  // Declared above `forget` because the render-phase guard below calls it.
  const inFlight = useRef<AbortController | null>(null);
  const showWhenLoaded = useRef(false);

  const hide = useCallback(() => setShown(false), []);

  /**
   * The state half on its own, for the render-phase environment guard below.
   *
   * That path must not touch a ref — and does not need to: the `[path]` effect
   * already aborts whatever was in flight for the environment being left.
   */
  const dropValues = useCallback(() => {
    setValues(null);
    setShown(false);
  }, []);

  const forget = useCallback(() => {
    // A decryption still in flight is part of what is being forgotten. It was
    // issued against the environment as it stood *before* the write that is
    // calling this, so letting it land would repopulate the cache with the
    // superseded plaintexts — rendered beside the new version chips, put on the
    // clipboard by Copy, and handed to the editor as the seed for the next
    // edit, which would write them straight back over what was just saved.
    inFlight.current?.abort();
    inFlight.current = null;
    // Otherwise a later reveal, upgraded onto this aborted request, would show
    // whatever the next one loads without being asked to.
    showWhenLoaded.current = false;
    // Dropping the plaintexts from state is the point: they must not survive in
    // a React fibre for the rest of the page's life, where the next error
    // boundary or dev-tools inspection would surface every one of them.
    dropValues();
    // The aborted request's handlers both return early, so nothing else clears
    // this and the button would spin for the rest of the page's life.
    setLoading(false);
  }, [dropValues]);

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
    if (values !== null) dropValues();
  }

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

      if (io === null) {
        // An `e2ee` environment this browser cannot open. The screen above
        // already says why; a button that spun forever would say nothing.
        setError('Could not reveal these values.');
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      showWhenLoaded.current = show;
      setLoading(true);

      // The signal goes *into* the pull, not merely around it. In `e2ee` mode
      // this is one request followed by a decryption per secret, and a controller
      // the IO never saw could only cancel the fetch — leaving hundreds of
      // AES-GCM opens running into a screen the person has already left, each one
      // putting another plaintext into a promise chain whose result is discarded.
      io.pull({ signal: controller.signal })
        .then((plaintexts) => {
          if (controller.signal.aborted) return;

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
    [io, values],
  );

  const reveal = useCallback(() => request(true), [request]);
  const load = useCallback(() => request(false), [request]);

  // The end of the window masks; it does not drop the decryption. The two are
  // different acts — see `usePlaintextCache` — and only masking is about what
  // can be read off an unattended screen. Pressing "Reveal all" again after the
  // window lapses is then instant and writes no second `secret.read` record,
  // while everything that makes this snapshot *wrong* still calls `forget`.
  //
  // Counted from the moment they went on screen, and restarted whenever they go
  // back on it: `shown` is in the deps because the window now governs what can
  // be read off an unattended screen rather than how long the decryption lives.
  // What bounds the decryption is `forget`, which every write calls.
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
