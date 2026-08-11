'use client';

import Link from 'next/link';

import { appPath } from '@/app/(dashboard)/_lib/paths';
import { cn } from '@/lib/cn';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { ArrowRightIcon, Skeleton } from '@/components/ui';
import { EnvironmentBadge } from './environment-badge';
import type { Environment } from './types';

/**
 * How many secrets an environment holds, once the count has arrived.
 *
 * `undefined` means the count is still loading; `null` means the viewer may not
 * read this environment, which for production is the normal case rather than an
 * error. See `EnvironmentCards`.
 */
export type SecretCounts = Readonly<Record<string, number | null | undefined>>;

export interface EnvironmentCardsProps {
  orgSlug: string;
  projectSlug: string;
  environments: readonly Environment[];
  counts: SecretCounts;
}

/**
 * The environments of a project.
 *
 * ── Why an unreadable environment still appears ──
 * `GET …/projects/{slug}` lists every environment to anyone who may read the
 * project, because an environment's name, order and production flag are the
 * shape of the project rather than its contents. Its *secret count* is a
 * different question, answered by `GET …/environments/{slug}`, which production
 * denies to a developer with no grant. So the card is drawn either way and the
 * count reads "no access" — which is a far better answer than a missing row,
 * because the environment demonstrably exists and someone who needs it now knows
 * what to ask for.
 */
export function EnvironmentCards({
  orgSlug,
  projectSlug,
  environments,
  counts,
}: EnvironmentCardsProps) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {environments.map((environment) => {
        const count = counts[environment.slug];

        return (
          <li key={environment.slug}>
            <Link
              href={appPath.environment(orgSlug, projectSlug, environment.slug)}
              className={cn(
                'group bg-surface shadow-raised relative flex h-full flex-col overflow-hidden rounded-xl border p-5 transition-colors',
                environment.isProduction
                  ? 'border-production-line hover:bg-production-tint/40'
                  : 'border-line hover:border-line-strong hover:bg-surface-hover',
              )}
            >
              {environment.isProduction ? (
                // The hazard hatching from globals.css, as a strip along the top
                // edge. Colour is never the only signal for production: this
                // survives greyscale and every form of colour vision deficiency,
                // and it is decorative because the badge below carries the word.
                <span aria-hidden="true" className="x-hazard absolute inset-x-0 top-0 h-1.5" />
              ) : null}

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-fg block truncate text-[0.9375rem] font-semibold tracking-tight">
                    {environment.name}
                  </span>
                  <span className="text-fg-subtle mt-0.5 block truncate font-mono text-xs">
                    {environment.slug}
                  </span>
                </div>
                <EnvironmentBadge isProduction={environment.isProduction} />
              </div>

              <div className="border-line-subtle mt-4 flex items-center justify-between gap-3 border-t pt-3">
                <span className="text-fg-muted text-sm">
                  {count === undefined ? (
                    <Skeleton className="inline-block h-3.5 w-20 align-middle" />
                  ) : count === null ? (
                    <span className="text-fg-subtle">No access</span>
                  ) : (
                    pluralize(count, 'secret')
                  )}
                </span>
                <ArrowRightIcon className="text-fg-subtle size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </div>

              <span className="text-fg-subtle mt-2 text-xs">
                <time
                  dateTime={toIsoString(environment.updatedAt)}
                  title={formatAbsoluteTime(environment.updatedAt)}
                >
                  Updated {formatRelativeTime(environment.updatedAt)}
                </time>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
