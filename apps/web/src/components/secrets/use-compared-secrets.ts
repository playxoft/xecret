'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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
 * authors — no ciphertext is read and nothing is decrypted. Shift-clicking
 * staging to put it beside dev must not decrypt staging; the values arrive one
 * at a time, through the audited reveal, when somebody actually asks for one.
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
  truncated: boolean;
}

const EMPTY: Entry = {
  io: null,
  loading: true,
  error: null,
  byName: new Map(),
  truncated: false,
};

export interface ComparedSecrets {
  environments: readonly ComparedEnvironment[];
  /** Refetches everything — called after a compared value has been written. */
  reload: () => void;
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
                truncated: previous?.truncated ?? false,
              },
            };
          });
        });
    }

    return () => controller.abort();
  }, [orgSlug, orgId, projectSlug, key, attempt]);

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
