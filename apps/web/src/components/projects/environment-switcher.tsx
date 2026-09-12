'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { MouseEvent } from 'react';

import { cn } from '@/lib/cn';
import { useGlobalShortcuts } from '@/components/layout';
import type { ShortcutChord } from '@/components/layout';
import {
  ariaKeyShortcuts,
  ariaModKey,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MoreHorizontalIcon,
  PlusIcon,
  Shortcut,
  useModKey,
} from '@/components/ui';
import { askBeforeLeaving } from '@/components/ui/leave-guard';
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
 *
 * ── The keyboard ──
 * Two chords on the same digits, doing the two things this switcher does.
 *
 *  - **`⇧1` `⇧2` `⇧3` navigate** to the first three environments in the
 *    project's own order — which is `sort_order`, so they are dev, staging and
 *    production in almost every project — and `⇧4` steps to the *next* one,
 *    wrapping. That last chord is what reaches a fifth and a sixth without
 *    inventing a cap for each.
 *  - **`⌘⇧1` … `⌘⇧9`, `⌘⇧0` compare**, adding and removing an environment from
 *    the comparison shown beneath this one — the keyboard's answer to
 *    shift-click, and unlike shift-click it reaches every environment rather
 *    than only the ones with a capsule. `0` is the tenth, following the tab
 *    convention every browser already teaches. Past the tenth the overflow
 *    menu remains the way in, as it is for the pointer.
 *
 * Navigating and comparing differ only by the mod key, which is right: they are
 * the same question — "what about staging?" — answered by going there or by
 * bringing it here.
 *
 * Shift-chords rather than bare digits, because this screen is full of fields
 * people paste into and a bare `1` that navigated away mid-edit would be
 * indistinguishable from data loss. `useGlobalShortcuts` stands down inside any
 * text field regardless; the modifier is the second lock.
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

/** How many capsules carry a numbered cap. `⇧4` is "the next one" instead. */
const DIRECT_SHORTCUTS = 3;

/**
 * The digit each environment's compare chord uses, by position.
 *
 * `1`–`9` then `0` for the tenth, which is the ordering every browser's tab
 * shortcuts already teach. An eleventh environment gets no chord; the overflow
 * menu lists it, exactly as it does for the pointer.
 */
const COMPARE_CODES = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
] as const;

/** The cap printed for a compare chord — `'1'` … `'9'`, then `'0'`. */
function compareDigit(index: number): string | null {
  return index < COMPARE_CODES.length ? String((index + 1) % 10) : null;
}

export function EnvironmentSwitcher({
  environments,
  currentSlug,
  href,
  onCreate,
  onCompare,
  comparing,
  className,
}: EnvironmentSwitcherProps) {
  const router = useRouter();
  // `null` until the first commit, which is what keeps the server's markup and
  // the browser's identical — see `useModKey`. The compare caps simply do not
  // draw until then.
  const mod = useModKey();

  // Declared before the early return, because hooks cannot run conditionally.
  // A no-op when the environment it names does not exist, so a project with one
  // environment simply has three dead chords rather than a branch.
  const go = useCallback(
    (target: Environment | undefined) => {
      if (target === undefined || target.slug === currentSlug) return;
      const to = href(target.slug);
      // The same guard the nav shortcuts use: a chord is a door
      // `UnsavedChangesGuard` cannot watch, and this screen is the one holding
      // a table of half-typed values.
      if (askBeforeLeaving(to)) return;
      router.push(to);
    },
    [currentSlug, href, router],
  );

  const bindings = useMemo(() => {
    const map: Partial<Record<ShortcutChord, () => void>> = {
      'shift:Digit1': () => go(environments[0]),
      'shift:Digit2': () => go(environments[1]),
      'shift:Digit3': () => go(environments[2]),
      'shift:Digit4': () => {
        // "The next one", wrapping — the only navigation chord that reaches an
        // environment past the third, however many there are.
        const index = environments.findIndex((entry) => entry.slug === currentSlug);
        if (index === -1) return;
        go(environments[(index + 1) % environments.length]);
      },
    };

    // Comparing is offered only where there is somewhere to show a comparison,
    // and never for the environment already on screen — comparing a page with
    // itself is the one answer nobody needs. Bound for every environment up to
    // the tenth, not just the four with capsules: the chord is the *only* route
    // that scales past what the row can draw.
    if (onCompare !== undefined) {
      environments.slice(0, COMPARE_CODES.length).forEach((environment, index) => {
        if (environment.slug === currentSlug) return;
        map[`mod+shift:${COMPARE_CODES[index]}`] = () => onCompare(environment.slug);
      });
    }

    return map;
  }, [go, environments, currentSlug, onCompare]);

  useGlobalShortcuts(bindings);

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
        // The cap belongs to the environment's position in the *project's*
        // order, not its position in this row — the row can drop an
        // environment into the overflow menu, and the chord follows the
        // environment rather than the slot it happens to be drawn in.
        const rank = environments.indexOf(environment);
        const chord = rank >= 0 && rank < DIRECT_SHORTCUTS ? `${rank + 1}` : null;

        return (
          <Link
            key={environment.slug}
            href={href(environment.slug)}
            aria-current={active ? 'page' : undefined}
            aria-keyshortcuts={chord === null ? undefined : ariaKeyShortcuts(['Shift', chord])}
            {...(onCompare === undefined || active
              ? {}
              : {
                  // The `href` survives: middle-click, ctrl-click and the
                  // keyboard all still navigate, and only the shifted click is
                  // taken. `aria-keyshortcuts` is not used here because this is
                  // a modifier on a pointer act, not a shortcut.
                  onClick: (event: MouseEvent<HTMLAnchorElement>) => {
                    // Shift *alone*. Ctrl+Shift+click and Cmd+Shift+click are the
                    // browser's "open in a new foreground tab", and taking them
                    // here swallowed the gesture: no tab, and an environment
                    // silently added to the comparison instead.
                    if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
                    event.preventDefault();
                    onCompare(environment.slug);
                  },
                  'aria-description': compared
                    ? 'Shown on this page. Shift-click to remove it.'
                    : 'Shift-click to show it on this page as well.',
                  title: compared
                    ? `${environment.name} is shown on this page — shift-click to remove it`
                    : `Open ${environment.name}, or shift-click to show it here as well`,
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
            {/* Only on the capsules you are not already on: a cap that goes
                where you already are is an offer with nothing behind it.
                Hidden on narrow screens, where the row is tight and there is
                usually no keyboard to press them with. */}
            {chord !== null && !active ? (
              <Shortcut keys={['Shift', chord]} className="ml-1.5 hidden sm:inline-flex" />
            ) : null}
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
            {/* Where `⇧4` is advertised: it has no capsule of its own, because
                what it goes to changes with where you are. */}
            <DropdownMenuLabel className="flex items-center justify-between gap-3 font-normal">
              <span>Next environment</span>
              <Shortcut keys={['Shift', '4']} />
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

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
                {/* "Show", not "Compare": the page puts these environments side
                    by side to be *worked* in — revealed, edited, filled in —
                    not only to be read against each other. */}
                <DropdownMenuLabel>Show on this page</DropdownMenuLabel>
                {environments.map((environment, index) => {
                  if (environment.slug === currentSlug) return null;
                  // The digit follows the environment's position in the
                  // project, so the cap here and the chord that fires are read
                  // off the same index — the list is filtered for display only.
                  const digit = compareDigit(index);

                  return (
                    <DropdownMenuCheckboxItem
                      key={`compare-${environment.slug}`}
                      // Checkboxes, not radio items: several environments can be
                      // on screen at once, so each entry is on or off rather
                      // than one of them being the choice.
                      checked={comparing?.has(environment.slug) ?? false}
                      onCheckedChange={() => onCompare(environment.slug)}
                      // Kept open, because the point of the list is to turn on
                      // more than one. Radix closes a menu on select by default,
                      // which would mean reopening it once per environment.
                      onSelect={(event) => event.preventDefault()}
                      {...(digit === null || mod === null
                        ? {}
                        : {
                            // The same modifier the cap beside it draws, named
                            // as the attribute's grammar wants it. Hardcoding
                            // `Control` announced a chord a Mac user does not
                            // have while the cap next to it printed ⌘.
                            'aria-keyshortcuts': ariaKeyShortcuts([
                              ariaModKey(mod),
                              'Shift',
                              digit,
                            ]),
                          })}
                    >
                      <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                      {/* This menu is where the multi-environment view is
                          discovered — the capsules only ever hint at it through a
                          shift-click nobody can see — so it is also where its
                          chord is advertised. */}
                      {digit !== null && mod !== null ? (
                        <Shortcut keys={[mod, 'Shift', digit]} />
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  );
                })}
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
