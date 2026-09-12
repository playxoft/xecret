'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import {
  clientSecretIo,
  fetchEnvironmentKeys,
  openEnvironmentKeys,
  serverSecretIo,
} from '@/components/envkeys';
import type { SecretIo } from '@/components/envkeys';
import { readVaultKeys } from '@/components/vault/key-store';
import type { EnvironmentTarget } from './environment-target';
import type { SecretListResponse, SecretSummary } from './types';

/**
 * The masked listings of the environments being compared alongside this one.
 *
 * ── What it fetches, and what it deliberately does not ──
 * `GET …/secrets` per compared environment: names, versions, timestamps,
 * authors — no ciphertext is read and nothing is decrypted. Putting staging
 * beside dev must not decrypt staging; the values arrive when somebody asks for
 * them, one at a time through the audited reveal, or a whole environment at a
 * time through `loadValues` below — which is what "Reveal all" and "Reveal on
 * hover" call, so those two mean every environment on screen rather than only
 * the one the page is about.
 *
 * ── One request per environment, not one per row ──
 * Sixty rows comparing two environments is two requests, because the answer is
 * a whole listing rather than sixty lookups. The result is keyed by name so a
 * row can find itself in it without scanning.
 *
 * A failure is per environment and does not disturb the others: comparing three
 * environments where you lack production's grant should still show staging.
 *
 * ── The second request, and why it is here ──
 * Each compared environment also gets its own `GET …/keys`, because a compared
 * cell can reveal and can be written to — and in `e2ee` mode both need that
 * environment's own key, not the one the page is about. Resolving it here rather
 * than inside the cell is what keeps it two requests per environment instead of
 * two per environment per row. An environment whose key this browser cannot open
 * yields `io: null`, and the cell renders masked and read-only rather than
 * failing when somebody clicks it.
 */

/** The API clamps `limit` to 200, and matches the environment screen's page. */
const PAGE_SIZE = 200;

export interface ComparedEnvironment extends EnvironmentTarget {
  /**
   * How this environment's values are read and written.
   *
   * `null` while the key state is still loading, and for an `e2ee` environment
   * this browser holds no grant for. A cell with no IO shows the mask and
   * refuses the editor — which is the truth: the row exists, the name is
   * readable, and the value is not.
   */
  io: SecretIo | null;
  loading: boolean;
  /** A fixed string; nothing from the thrown value is kept. See `lib/api.ts`. */
  error: string | null;
  byName: ReadonlyMap<string, SecretSummary>;
  /**
   * This environment's plaintexts, name → value, once `loadValues` has pulled
   * them. `null` until then, and again after `forgetValues`.
   *
   * Holding them here rather than in each cell is the same decision
   * `useRevealAll` makes for the environment the page is about: one `pull` per
   * environment, one `secret.read` record for the click that asked, instead of
   * one request and one record per row. Whether they are *shown* is not this
   * hook's business — the table gates that on the same reveal window and hover
   * set the primary column uses, so everything on screen masks on one clock.
   */
  values: Readonly<Record<string, string>> | null;
  /**
   * Whether the environment holds more than this one page.
   *
   * Carried because a row's only question is "does this environment have my
   * key", and the honest answer past the first page is "cannot say from here".
   * A comparison that silently reports "not set" for key 201 is worse than one
   * that admits its horizon — this is a secrets manager, and "production does
   * not have this" is exactly the kind of wrong answer that ends in an outage.
   */
  truncated: boolean;
}

interface Entry {
  io: SecretIo | null;
  loading: boolean;
  error: string | null;
  byName: ReadonlyMap<string, SecretSummary>;
  values: Readonly<Record<string, string>> | null;
  truncated: boolean;
}

const EMPTY: Entry = {
  io: null,
  loading: true,
  error: null,
  byName: new Map(),
  values: null,
  truncated: false,
};

export interface ComparedSecrets {
  environments: readonly ComparedEnvironment[];
  /** Refetches everything — called after a compared value has been written. */
  reload: () => void;
  /**
   * Decrypts every compared environment, once each.
   *
   * Idempotent and cheap to call again: an environment that already has its
   * snapshot, or a pull already in flight, is skipped. An environment this
   * browser cannot open is skipped too — its cells keep the mask and their own
   * eye, which is the honest version of "not available here".
   *
   * A failure is deliberately silent at this level. The cells fall back to
   * revealing one value at a time, reporting their own reason where the user is
   * looking; a banner over the table saying an environment could not be
   * decrypted would be the same news twice over, and usually for an environment
   * the reader was not reading.
   */
  loadValues: () => void;
  /**
   * Drops every compared plaintext, and aborts the pulls still arriving.
   *
   * Called by the same things that call `RevealAll.forget`: a write, a delete,
   * an import, a change of environment. A snapshot that outlives what it
   * describes is worse than no snapshot — it keeps a replaced credential on
   * screen, puts it on the clipboard, and seeds it into the next edit.
   */
  forgetValues: () => void;
}

export function useComparedSecrets(
  orgSlug: string,
  orgId: string,
  projectSlug: string,
  environments: readonly EnvironmentTarget[],
): ComparedSecrets {
  const [entries, setEntries] = useState<Readonly<Record<string, Entry>>>({});
  const [attempt, setAttempt] = useState(0);

  // The identity of an array prop changes on every render of the parent, which
  // as an effect dependency is an infinite fetch. The slugs are what this hook
  // is actually about, and they are a string.
  const key = environments.map((environment) => environment.slug).join(',');
  const slugs = key.length === 0 ? [] : key.split(',');

  // Adjusted during render rather than in an effect, which is React's
  // documented way to react to a changed prop — and here it is the only correct
  // one: an effect runs after paint, so an environment dropped from the
  // comparison would have its values rendered for a frame after the user said
  // to stop showing them. State, not a ref, because a ref read during render
  // cannot schedule the re-render this needs.
  const [renderedKey, setRenderedKey] = useState(key);
  if (renderedKey !== key) {
    setRenderedKey(key);
    setEntries((current) => {
      const next: Record<string, Entry> = {};
      for (const slug of slugs) next[slug] = current[slug] ?? EMPTY;
      return next;
    });
  }

  useEffect(() => {
    const wanted = key.length === 0 ? [] : key.split(',');
    if (wanted.length === 0) return;

    const controller = new AbortController();

    for (const slug of wanted) {
      // The listing and the key state, together. `Promise.all` rather than two
      // independent chains so a cell never renders against one environment's
      // names and another moment's key.
      Promise.all([
        api.get<SecretListResponse>(
          withQuery(apiPath.secrets(orgSlug, projectSlug, slug), { limit: PAGE_SIZE }),
          { signal: controller.signal },
        ),
        comparedIo({ orgSlug, orgId, projectSlug, envSlug: slug }, controller.signal),
      ])
        .then(([response, io]) => {
          if (controller.signal.aborted) return;
          const byName = new Map(response.data.map((secret) => [secret.name, secret]));
          setEntries((current) => ({
            ...current,
            [slug]: {
              io,
              loading: false,
              error: null,
              byName,
              // The snapshot is kept across a refetch: `reload()` runs after
              // every compared write, and dropping the plaintexts here would
              // re-mask an environment the user is reading because they saved a
              // value in a different one. What makes a snapshot *wrong* calls
              // `forgetValues`, which is the write path's job and not this one's.
              values: current[slug]?.values ?? null,
              truncated: response.nextCursor !== null,
            },
          }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setEntries((current) => {
            // A refetch that fails must not take the listing with it. `reload()`
            // re-reads *every* compared environment after any compared write, so
            // one transient 5xx on an environment the user never touched used to
            // replace all of its cells with an error — data that was on screen a
            // moment ago, with no retry control anywhere to get it back. The
            // error is reported over the listing that is still good.
            const previous = current[slug];
            return {
              ...current,
              [slug]: {
                io: previous?.io ?? null,
                loading: false,
                error: 'Could not read this environment.',
                byName: previous?.byName ?? new Map(),
                values: previous?.values ?? null,
                truncated: previous?.truncated ?? false,
              },
            };
          });
        });
    }

    return () => controller.abort();
  }, [orgSlug, orgId, projectSlug, key, attempt]);

  /**
   * The pull in flight per environment, so a second "Reveal all" cannot start a
   * second decryption of the same one — and so a response for an environment
   * that has been dropped from the view, or invalidated by a write, is discarded
   * rather than rendered.
   */
  const pulls = useRef(new Map<string, AbortController>());

  const abortPulls = useCallback(() => {
    for (const controller of pulls.current.values()) controller.abort();
    pulls.current.clear();
  }, []);

  // Everything in flight belongs to the environments that were on screen when it
  // was issued. Unmounting, or changing which environments those are, abandons
  // it: the decryptions behind a `pull` are hundreds of AES-GCM opens in `e2ee`
  // mode, and finishing them into a screen nobody is looking at only produces
  // plaintexts for a state that no longer exists.
  useEffect(() => () => abortPulls(), [abortPulls, key]);

  const loadValues = useCallback(() => {
    for (const [slug, entry] of Object.entries(entries)) {
      // Nothing to open with, a snapshot already here, or a pull already out.
      if (entry.io === null || entry.values !== null || pulls.current.has(slug)) continue;

      const controller = new AbortController();
      pulls.current.set(slug, controller);

      // The signal goes *into* the pull rather than around it, for the reason
      // `useRevealAll` gives: in `e2ee` mode a pull is one request followed by a
      // decryption per secret, and a controller the IO never saw could cancel
      // only the fetch.
      entry.io
        .pull({ signal: controller.signal })
        .then((values) => {
          if (controller.signal.aborted) return;
          setEntries((current) => {
            const previous = current[slug];
            // Gone from the view, or refetched into a different environment's
            // slot: either way these plaintexts have nowhere to belong.
            if (previous === undefined) return current;
            return { ...current, [slug]: { ...previous, values } };
          });
        })
        .catch(() => {
          // Silent by design — see `loadValues` on `ComparedSecrets`. The cells
          // keep their own eye, which reports its own reason.
        })
        .finally(() => {
          if (pulls.current.get(slug) === controller) pulls.current.delete(slug);
        });
    }
  }, [entries]);

  const forgetValues = useCallback(() => {
    abortPulls();
    setEntries((current) => {
      let changed = false;
      const next: Record<string, Entry> = {};
      for (const [slug, entry] of Object.entries(current)) {
        if (entry.values === null) {
          next[slug] = entry;
          continue;
        }
        changed = true;
        // A new object, so the plaintexts are not left reachable through the
        // previous one: they must not survive in a React fibre for the rest of
        // the page's life, where the next error boundary or dev-tools
        // inspection would surface every one of them.
        next[slug] = { ...entry, values: null };
      }
      return changed ? next : current;
    });
  }, [abortPulls]);

  const compared = useMemo(
    () =>
      environments.map((environment) => {
        const entry = entries[environment.slug] ?? EMPTY;
        return { ...environment, ...entry };
      }),
    [environments, entries],
  );

  return {
    environments: compared,
    reload: useCallback(() => setAttempt((current) => current + 1), []),
    loadValues,
    forgetValues,
  };
}

/**
 * The IO for one compared environment, or `null` when it cannot be opened.
 *
 * Reads the vault keys from the store rather than through the React context: a
 * hook cannot be called per environment in a loop, and the store is the same
 * object the context subscribes to. The effect above re-runs on `attempt`, so a
 * comparison opened while locked picks the keys up on the next reload rather
 * than staying dead for the life of the page.
 *
 * Every failure — no access, no grant, a locked vault — is `null` rather than a
 * throw, because none of them should take the *listing* down with them. The
 * names are still readable and are most of what a comparison is for.
 */
async function comparedIo(
  context: { orgSlug: string; orgId: string; projectSlug: string; envSlug: string },
  signal: AbortSignal,
): Promise<SecretIo | null> {
  try {
    const keys = await fetchEnvironmentKeys(context, { signal });
    if (keys.encryptionMode !== 'e2ee') return serverSecretIo(context);

    const opened = await openEnvironmentKeys(keys, readVaultKeys());
    return opened.status === 'open' ? clientSecretIo(context, opened.material) : null;
  } catch {
    return null;
  }
}
