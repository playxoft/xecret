'use client';

import { useEffect, useState } from 'react';

import {
  isReservedSlug,
  ORGANIZATION_SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from '@xecret/core/validation';
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
 * Validates a slug against the rules the server applies, in one sentence.
 *
 * The clauses come from `@xecret/core/validation`, so there is still only one
 * definition of what a valid slug is; only the wording differs. `slugSchema`'s
 * own output is a zod issue list written for a developer, and this needs a line
 * written for the person typing. (`create-project-dialog.tsx` does the same, for
 * the same reason.)
 *
 * ── Why the hyphen rules get their own messages ──
 * `normalizeSlugInput` deliberately lets a trailing hyphen be typed, because
 * stripping it is what made `acme-corp` untypable. The consequence is that
 * "invalid" is now a normal, transient state that a user passes through on the
 * way to a valid slug — so the message has to say precisely which rule is
 * unmet. "Use lowercase letters, digits and single hyphens" is useless to
 * somebody who has just typed a hyphen and can see that they did.
 */
export function describeSlugProblem(slug: string): string | null {
  if (slug.length === 0) return 'Enter a slug.';
  if (slug.length > ORGANIZATION_SLUG_MAX_LENGTH) {
    return `A slug can be at most ${ORGANIZATION_SLUG_MAX_LENGTH} characters.`;
  }
  // Ordered so the transient case a user is most likely to be in — mid-word,
  // hyphen just pressed — is the one they are told about.
  if (slug.endsWith('-')) return 'A slug cannot end with a hyphen. Add a letter or digit after it.';
  if (slug.startsWith('-')) return 'A slug cannot start with a hyphen.';
  if (slug.includes('--')) return 'Use single hyphens — two in a row is not allowed.';
  if (!SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, digits and single hyphens — no spaces.';
  }
  if (isReservedSlug(slug)) return 'That slug is reserved. Choose a different one.';
  return null;
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
