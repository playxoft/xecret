'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';

import { cn } from '@/lib/cn';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
 *
 * ── Shift-click compares instead of navigating ──
 * "Is this the same value as staging?" is the question this switcher was built
 * for, and clicking through to find out answers it from memory: you read
 * staging's value on staging's page, then go back and hope. Shift-clicking a
 * capsule brings that environment *here* instead — its values appear under this
 * environment's, key by key, on the one screen where they can be compared side
 * by side. Nothing is decrypted by the act: the compared listing is masked like
 * any other, and each value is revealed on request through the audited endpoint.
 *
 * Shift-click is the modifier every file manager and every editor already uses
 * for "and also this one", and a plain click still navigates — the common act
 * keeps the cheapest gesture. It is not the *only* way in, though: a modifier on
 * a pointer gesture is unreachable from a keyboard and undiscoverable on a
 * touchscreen, so the overflow menu lists every environment as an ordinary
 * command. That list is also the only route to an environment past the fourth,
 * which never gets a capsule to shift-click.
 */

export interface EnvironmentSwitcherProps {
  environments: readonly Environment[];
  currentSlug: string;
  /** Builds the address of an environment. */
  href: (slug: string) => string;
  /** Shown as the last item in the overflow menu, when the viewer may create one. */
  onCreate?: (() => void) | undefined;
  /**
   * Turns shift-click into "compare this environment here" instead of a
   * navigation. Absent on screens that have nowhere to show a comparison.
   */
  onCompare?: ((slug: string) => void) | undefined;
  /** Which environments are currently being compared, so their capsules say so. */
  comparing?: ReadonlySet<string> | undefined;
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
  onCompare,
  comparing,
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
        const compared = comparing?.has(environment.slug) ?? false;
        return (
          <Link
            key={environment.slug}
            href={href(environment.slug)}
            aria-current={active ? 'page' : undefined}
            {...(onCompare === undefined || active
              ? {}
              : {
                  // The `href` survives: middle-click, ctrl-click and the
                  // keyboard all still navigate, and only the shifted click is
                  // taken. `aria-keyshortcuts` is not used here because this is
                  // a modifier on a pointer act, not a shortcut.
                  onClick: (event: MouseEvent<HTMLAnchorElement>) => {
                    if (!event.shiftKey) return;
                    event.preventDefault();
                    onCompare(environment.slug);
                  },
                  'aria-description': compared
                    ? 'Being compared here. Shift-click to stop.'
                    : 'Shift-click to compare it on this page.',
                  title: compared
                    ? `${environment.name} is being compared here — shift-click to stop`
                    : `Open ${environment.name}, or shift-click to compare it here`,
                })}
            className={cn(
              'relative rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors',
              active
                ? 'bg-surface text-fg shadow-raised font-medium'
                : 'text-fg-muted hover:text-fg',
              // Production gets a mark whether or not it is selected. It is the
              // one environment where the cost of acting on the wrong tab is
              // different in kind, so it must be identifiable at a glance
              // rather than by reading the label.
              environment.isProduction && active && 'text-production-text',
              // A compared environment is neither here nor elsewhere: it is on
              // this page without being what the page is about, and the outline
              // says exactly that much without competing with the active fill.
              // `--accent-line` is a chip edge, ~1.2:1, and is documented as
              // exempt from contrast because it is normally decoration. Here the
              // outline is the *only* thing saying an environment is being
              // compared, so it has to be a colour that can actually be seen.
              compared && 'ring-fg-subtle text-fg ring-1 ring-inset',
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

      {overflow.length > 0 || onCreate || onCompare ? (
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
          <DropdownMenuContent align="end" className="w-56">
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

            {onCompare ? (
              <>
                {overflow.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>Compare on this page</DropdownMenuLabel>
                {environments
                  .filter((environment) => environment.slug !== currentSlug)
                  .map((environment) => (
                    <DropdownMenuCheckboxItem
                      key={`compare-${environment.slug}`}
                      // Checkboxes, not radio items: several environments can be
                      // compared at once, so each entry is on or off rather than
                      // one of them being the choice.
                      checked={comparing?.has(environment.slug) ?? false}
                      onCheckedChange={() => onCompare(environment.slug)}
                      // Kept open, because the point of the list is to turn on
                      // more than one. Radix closes a menu on select by default,
                      // which would mean reopening it once per environment.
                      onSelect={(event) => event.preventDefault()}
                    >
                      {environment.name}
                    </DropdownMenuCheckboxItem>
                  ))}
              </>
            ) : null}

            {onCreate ? (
              <>
                {overflow.length > 0 || onCompare ? <DropdownMenuSeparator /> : null}
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
