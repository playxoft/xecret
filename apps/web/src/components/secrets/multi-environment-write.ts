'use client';

import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import type { DraftSeed } from './staged-changes';

/**
 * Writing one set of keys into several environments at once.
 *
 * ── The thing this makes possible ──
 * A new service needs the same eight keys in dev, staging and production, with
 * three different values only for two of them. Doing that one environment at a
 * time means three visits, three pastes, and a real chance of missing one — and
 * a key that exists in staging but not production is a deploy that fails at the
 * worst moment, which is the failure this whole product is supposed to prevent.
 *
 * ── Why it writes rather than staging rows ──
 * The table's draft rows belong to the environment on screen; there is nowhere
 * to put a pending row for an environment you are not looking at. So a
 * multi-environment paste is an immediate write, and the UI treats it as one:
 * it is confirmed before it runs, and production is named in the confirmation.
 *
 * ── Ordering and failure ──
 * Sequential, deliberately, for the same reason the single-environment save is:
 * every write is an audited mutation against `RL_MUTATION`, and firing
 * twenty-four at once would trip the rate limit and leave a partial result
 * nobody asked for.
 *
 * A failure does not stop the run. Getting seven of eight keys into production
 * and being told which one failed is strictly better than stopping at the
 * second and leaving the user to work out where the boundary fell. Every
 * outcome is reported per environment and per key.
 */

export interface EnvironmentTarget {
  slug: string;
  name: string;
  isProduction: boolean;
}

export type WriteStatus = 'created' | 'skipped' | 'failed';

export interface KeyOutcome {
  name: string;
  status: WriteStatus;
  /** Present when `status` is `failed`; safe to show, never contains a value. */
  reason?: string;
}

export interface EnvironmentOutcome {
  slug: string;
  name: string;
  created: number;
  skipped: number;
  failed: number;
  keys: readonly KeyOutcome[];
}

export interface MultiWriteParams {
  orgSlug: string;
  projectSlug: string;
  targets: readonly EnvironmentTarget[];
  seeds: readonly DraftSeed[];
  /** Called after each environment finishes, so the panel can show progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Applies `seeds` to every target.
 *
 * A key that already exists in an environment is **skipped, not overwritten**.
 * That is the safe default and the only one that can be offered without a
 * per-environment diff: "paste these into every environment" is a request to
 * fill gaps, and silently replacing production's database password with a value
 * copied out of a dev `.env` is the single worst thing this feature could do.
 * Changing an existing value stays a deliberate, single-environment act.
 */
export async function writeToEnvironments(params: MultiWriteParams): Promise<EnvironmentOutcome[]> {
  const results: EnvironmentOutcome[] = [];

  for (const [index, target] of params.targets.entries()) {
    const keys: KeyOutcome[] = [];

    for (const seed of params.seeds) {
      const name = (seed.name ?? '').trim();
      if (name.length === 0) continue;

      try {
        await api.post(apiPath.secrets(params.orgSlug, params.projectSlug, target.slug), {
          name,
          value: seed.value ?? '',
          ...(seed.valueType === undefined ? {} : { valueType: seed.valueType }),
          ...((seed.note ?? '').trim().length === 0 ? {} : { note: (seed.note ?? '').trim() }),
        });
        keys.push({ name, status: 'created' });
      } catch (cause) {
        // A 409 means the name is taken, which is the skip case rather than a
        // failure — the environment already has that key and this run was never
        // going to change it.
        if (isApiError(cause) && cause.code === 'conflict') {
          keys.push({ name, status: 'skipped' });
          continue;
        }

        keys.push({
          name,
          status: 'failed',
          // `ApiError.message` is one of the server's fixed strings. Anything
          // else is collapsed rather than read: an arbitrary exception's message
          // may have been built from the request payload, which here is a
          // credential.
          reason: isApiError(cause) ? cause.message : 'Could not write this secret.',
        });
      }
    }

    results.push({
      slug: target.slug,
      name: target.name,
      created: keys.filter((key) => key.status === 'created').length,
      skipped: keys.filter((key) => key.status === 'skipped').length,
      failed: keys.filter((key) => key.status === 'failed').length,
      keys,
    });

    params.onProgress?.(index + 1, params.targets.length);
  }

  return results;
}
