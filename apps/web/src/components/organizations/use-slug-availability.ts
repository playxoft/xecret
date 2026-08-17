'use client';

import { useEffect, useState } from 'react';

import { checkSlug, ORGANIZATION_SLUG_MAX_LENGTH } from '@xecret/core/validation';
import { api } from '@/lib/api';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';

/**
 * Is this organisation slug free?
 *
 * ── Why this is a hook and not a call at submit time ──
 * An organisation slug is permanent. Discovering it was taken *after* pressing
 * Create means retyping a form; discovering it while typing means picking a
 * different word. The whole value is in the timing.
 *
 * ── What it will not do ──
 * It does not gate submission on a green tick. The answer is a snapshot, the
 * unique index is the real arbiter, and `POST /api/orgs` still returns a field
 * error on a collision — so a slug that is `unknown` here because the network
 * hiccuped is still worth submitting. Treating this as authoritative would be
 * check-then-act with extra steps.
 */
export type SlugAvailability =
  /** Nothing worth checking yet — the field is empty. */
  | { state: 'idle' }
  /** Fails the pattern or length rules; no request was made. */
  | { state: 'invalid'; message: string }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken'; message: string }
  /** The check itself failed. Not an error the user must act on — see above. */
  | { state: 'unknown' };

/**
 * How long to wait after the last keystroke.
 *
 * Long enough that typing `payments-platform` costs one request rather than
 * seventeen; short enough that the answer arrives while the user is still
 * looking at the field rather than after they have moved on.
 */
const DEBOUNCE_MS = 400;

interface AvailabilityResponse {
  slug: string;
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
}

/**
 * The rules an organisation slug must satisfy, as a line the person typing can
 * act on — or `null` when there is nothing to say.
 *
 * All this adds to `checkSlug` is the organisation's ceiling and the shape a
 * `Field` wants. It used to add the rules themselves, restated from
 * `SLUG_PATTERN` and `isReservedSlug`, which made this the third place that knew
 * what a valid slug is and the second that could disagree with `POST /api/orgs`.
 * The wording lives in `@xecret/core/validation` beside the rules it describes,
 * so a rule and its explanation are added in one edit.
 */
export function describeSlugProblem(slug: string): string | null {
  const check = checkSlug(slug, ORGANIZATION_SLUG_MAX_LENGTH);
  return check.valid ? null : check.message;
}

/**
 * The outcome of one completed check, carrying the slug it describes.
 *
 * Keyed by slug for the reason `useApiResource` keys its result by path: it is
 * what lets `checking` and `idle` be *derived* during render rather than written
 * by the effect. An effect that also had to set those states would need a
 * synchronous `setState` in its body on every keystroke — a cascading render,
 * and one that briefly paints a stale "available" tick under a slug the user has
 * already typed past.
 */
interface CheckedSlug {
  slug: string;
  available: boolean;
  reason?: AvailabilityResponse['reason'];
  /** The request itself failed. Distinct from `available: false`. */
  failed?: boolean;
}

export function useSlugAvailability(slug: string): SlugAvailability {
  const [checked, setChecked] = useState<CheckedSlug | null>(null);

  // Settled locally, during render: a slug that cannot be valid is not worth a
  // round trip, and "Use lowercase letters and hyphens" is a better answer than
  // "taken".
  const problem = slug.length === 0 ? null : describeSlugProblem(slug);
  const worthChecking = slug.length > 0 && problem === null;

  useEffect(() => {
    if (!worthChecking) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .get<AvailabilityResponse>(withQuery(apiPath.orgSlugAvailability(), { slug }), {
          signal: controller.signal,
        })
        .then((response) => {
          if (controller.signal.aborted) return;
          // A response describing some other slug is discarded rather than
          // stored. The abort in the cleanup covers the common case; this covers
          // one that had already resolved when it fired.
          if (response.slug !== slug) return;

          setChecked({
            slug,
            available: response.available,
            ...(response.reason === undefined ? {} : { reason: response.reason }),
          });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // Recorded, not surfaced as an error. The user is naming an
          // organisation, not diagnosing a network; the create request will give
          // them a real message if there is one to give.
          setChecked({ slug, available: false, failed: true });
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, worthChecking]);

  if (slug.length === 0) return { state: 'idle' };
  if (problem !== null) return { state: 'invalid', message: problem };

  // No answer yet, or one that belongs to a slug two keystrokes ago.
  if (checked === null || checked.slug !== slug) return { state: 'checking' };
  if (checked.failed === true) return { state: 'unknown' };
  if (checked.available) return { state: 'available' };

  return {
    state: 'taken',
    message:
      checked.reason === 'reserved'
        ? 'That slug is reserved. Choose a different one.'
        : 'That slug is already taken. Choose a different one.',
  };
}
