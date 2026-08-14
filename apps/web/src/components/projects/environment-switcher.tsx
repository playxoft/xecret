'use client';

import Link from 'next/link';

import { cn } from '@/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MoreHorizontalIcon,
  PlusIcon,
} from '@/components/ui';
import type { Environment } from './types';

/**
 * Environments as capsules, not a dropdown.
 *
 * ── Why this replaced a `<Select>` ──
 * Switching between dev, staging and production is the single most repeated
 * action on this screen — you compare a value across environments far more often
 * than you do anything else with one. A dropdown costs two clicks and hides the
 * options until the first of them; three capsules cost one click and are legible
 * without any. The old control was correct and slow, in the place where slow is
 * most expensive.
 *
 * ── Why an overflow menu rather than more capsules ──
 * Three environments is the shape of almost every project, and the default set
 * this product creates. A team with nine would get a row that wraps onto three
 * lines and pushes the table down the page, so the first few stay visible and
 * the rest collapse behind a `⋯`. Which few is not arbitrary — see `visibleSet`.
 *
 * ── Links, not buttons ──
 * Each capsule is an `<a>` to that environment's URL. Middle-click opens
 * production in a new tab; the browser's back button works; the address bar is
 * the truth. A button calling `router.push` would break all three for no gain.
 */

export interface EnvironmentSwitcherProps {
  environments: readonly Environment[];
  currentSlug: string;
  /** Builds the address of an environment. */
  href: (slug: string) => string;
  /** Shown as the last item in the overflow menu, when the viewer may create one. */
  onCreate?: (() => void) | undefined;
  className?: string;
}

/**
 * How many capsules stay on the row before the rest collapse.
 *
 * Four rather than three: the common project has exactly three environments, and
 * a limit of three would put a `⋯` beside a row that fits perfectly — the one
 * case where the overflow control is pure noise.
 */
const MAX_VISIBLE = 4;

export function EnvironmentSwitcher({
  environments,
  currentSlug,
  href,
  onCreate,
  className,
}: EnvironmentSwitcherProps) {
  if (environments.length === 0) return null;

  const { visible, overflow } = visibleSet(environments, currentSlug);

  return (
    // `group` rather than `tablist`: these are links to separate pages, not tabs
    // over panels in this document, and announcing them as tabs would promise a
    // screen reader user that arrow keys move between them without navigating.
    <div
      role="group"
      aria-label="Environment"
      className={cn(
        'border-line bg-canvas-inset inline-flex items-center gap-0.5 rounded-lg border p-0.5',
        className,
      )}
    >
      {visible.map((environment) => {
        const active = environment.slug === currentSlug;
        return (
          <Link
            key={environment.slug}
            href={href(environment.slug)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative rounded-md px-2.5 py-1 text-[0.8125rem] whitespace-nowrap transition-colors',
              active
                ? 'bg-surface text-fg shadow-raised font-medium'
                : 'text-fg-muted hover:text-fg',
              // Production gets a mark whether or not it is selected. It is the
              // one environment where the cost of acting on the wrong tab is
              // different in kind, so it must be identifiable at a glance
              // rather than by reading the label.
              environment.isProduction && active && 'text-production-text',
            )}
          >
            {environment.isProduction ? (
              <span
                aria-hidden="true"
                className={cn(
                  'mr-1.5 inline-block size-1.5 rounded-full align-middle',
                  active ? 'bg-production' : 'bg-production/60',
                )}
              />
            ) : null}
            {environment.name}
          </Link>
        );
      })}

      {overflow.length > 0 || onCreate ? (
        <DropdownMenu>
          {/* `⋯` alone tells a screen reader user nothing; the count tells
              them whether the menu is worth opening. */}
          <DropdownMenuTrigger
            className="text-fg-subtle hover:text-fg hover:bg-surface data-[state=open]:bg-surface grid size-7 shrink-0 place-items-center rounded-md transition-colors"
            aria-label={
              overflow.length > 0
                ? `${overflow.length} more environments`
                : 'More environment options'
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {overflow.length > 0 ? (
              <>
                <DropdownMenuLabel>More environments</DropdownMenuLabel>
                {overflow.map((environment) => (
                  <DropdownMenuItem key={environment.slug} asChild>
                    <Link href={href(environment.slug)}>
                      {environment.isProduction ? (
                        <span
                          aria-hidden="true"
                          className="bg-production inline-block size-1.5 shrink-0 rounded-full"
                        />
                      ) : null}
                      {environment.name}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}

            {onCreate ? (
              <>
                {overflow.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={onCreate}>
                  <PlusIcon className="size-4" />
                  New environment
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/**
 * Which environments stay on the row.
 *
 * The current one is **always** visible, even when it would have been the
 * seventh — a switcher that hides the thing you are looking at is worse than no
 * switcher. Otherwise the server's order is kept, which is `sort_order` and puts
 * dev, staging, production in the sequence a deploy moves through them.
 */
function visibleSet(
  environments: readonly Environment[],
  currentSlug: string,
): { visible: readonly Environment[]; overflow: readonly Environment[] } {
  if (environments.length <= MAX_VISIBLE) return { visible: environments, overflow: [] };

  const head = environments.slice(0, MAX_VISIBLE);
  if (head.some((environment) => environment.slug === currentSlug)) {
    return { visible: head, overflow: environments.slice(MAX_VISIBLE) };
  }

  // The current environment is past the cut, so it takes the last visible slot
  // and the one it displaced moves into the menu.
  const current = environments.find((environment) => environment.slug === currentSlug);
  if (!current) return { visible: head, overflow: environments.slice(MAX_VISIBLE) };

  const visible = [...head.slice(0, MAX_VISIBLE - 1), current];
  const overflow = environments.filter(
    (environment) => !visible.some((shown) => shown.slug === environment.slug),
  );

  return { visible, overflow };
}
