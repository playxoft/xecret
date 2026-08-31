'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import type { EnvironmentTarget } from './multi-environment-write';
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
 */

/** The API clamps `limit` to 200, and matches the environment screen's page. */
const PAGE_SIZE = 200;

export interface ComparedEnvironment extends EnvironmentTarget {
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
  loading: boolean;
  error: string | null;
  byName: ReadonlyMap<string, SecretSummary>;
  truncated: boolean;
}

const EMPTY: Entry = { loading: true, error: null, byName: new Map(), truncated: false };

export interface ComparedSecrets {
  environments: readonly ComparedEnvironment[];
  /** Refetches everything — called after a compared value has been written. */
  reload: () => void;
}

export function useComparedSecrets(
  orgSlug: string,
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
      api
        .get<SecretListResponse>(
          withQuery(apiPath.secrets(orgSlug, projectSlug, slug), { limit: PAGE_SIZE }),
          { signal: controller.signal },
        )
        .then((response) => {
          if (controller.signal.aborted) return;
          const byName = new Map(response.data.map((secret) => [secret.name, secret]));
          setEntries((current) => ({
            ...current,
            [slug]: {
              loading: false,
              error: null,
              byName,
              truncated: response.nextCursor !== null,
            },
          }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setEntries((current) => ({
            ...current,
            [slug]: {
              loading: false,
              error: 'Could not read this environment.',
              byName: new Map(),
              truncated: false,
            },
          }));
        });
    }

    return () => controller.abort();
  }, [orgSlug, projectSlug, key, attempt]);

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
