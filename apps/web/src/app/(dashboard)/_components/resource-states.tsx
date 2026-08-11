'use client';

import { errorMessage, isApiError } from '@/lib/api';
import { AlertTriangleIcon, Button, Card, RefreshIcon, Skeleton } from '@/components/ui';

/**
 * What a screen shows when its data has not arrived, or will not.
 *
 * Kept in one place so that "the request failed" looks and reads the same
 * everywhere, and above all so that the request id is never left out of one
 * screen because that screen was written on a different day.
 */

export interface ErrorStateProps {
  /** What the user was trying to see: "these projects", "this environment". */
  subject: string;
  error: unknown;
  onRetry?: () => void;
}

/**
 * A failure the user can act on.
 *
 * ── Why the request id is on screen ──
 * Every error the API returns carries one (§3 of the contract), and it is the
 * only thing that connects what the user saw to the server log line that
 * explains it. Without it a support conversation starts with "roughly when was
 * this, and what were you doing?", which is a question nobody can answer
 * accurately an hour later. It is deliberately selectable text rather than a
 * tooltip, because the next thing that happens to it is being pasted.
 *
 * The message itself comes from the server and is safe to render as-is: §3 fixes
 * it to a known set of strings, so nothing derived from an exception, a database
 * error, or the rejected request body — which in this product may be a secret
 * value — can reach it.
 */
export function ErrorState({ subject, error, onRetry }: ErrorStateProps) {
  const requestId = isApiError(error) ? error.requestId : null;
  const forbidden = isApiError(error) && error.code === 'forbidden';
  const missing = isApiError(error) && error.code === 'not_found';

  return (
    <Card className="border-danger-line p-6">
      <div className="flex gap-3.5">
        <AlertTriangleIcon className="text-danger-text mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-fg text-[0.9375rem] font-semibold">
            {missing
              ? `Could not find ${subject}`
              : forbidden
                ? `You do not have access to ${subject}`
                : `Could not load ${subject}`}
          </h2>
          <p className="text-fg-muted mt-1.5 text-sm leading-6">{errorMessage(error)}</p>

          {missing ? (
            // 404 also covers "exists, but not for you" — §3 makes the two
            // indistinguishable on purpose, so that a stranger cannot use this
            // screen to work out which slugs are real in another tenant.
            <p className="text-fg-subtle mt-1.5 text-[0.8125rem] leading-5">
              It may have been deleted, renamed, or it may belong to an organisation you are not a
              member of.
            </p>
          ) : null}

          {requestId ? (
            <p className="text-fg-subtle mt-3 text-[0.8125rem]">
              Quote this if you contact support:{' '}
              <code className="text-fg-muted bg-canvas-inset border-line rounded border px-1.5 py-0.5 font-mono text-xs select-all">
                {requestId}
              </code>
            </p>
          ) : null}

          {onRetry ? (
            <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
              <RefreshIcon className="size-4" />
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * A skeleton grid for card-shaped screens.
 *
 * `aria-busy` sits on the wrapper and the skeletons are `aria-hidden`, so a
 * screen reader hears one state change rather than a dozen empty boxes.
 */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="border-line bg-surface rounded-xl border p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-2/3" />
          <Skeleton className="mt-5 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="max-w-xl space-y-6">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-4 w-36" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-28" />
    </div>
  );
}
