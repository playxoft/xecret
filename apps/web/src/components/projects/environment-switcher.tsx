'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useMemo } from 'react';

import { cn } from '@/lib/cn';
import { useGlobalShortcuts } from '@/components/layout';
import type { ShortcutChord } from '@/components/layout';
import {
  ariaKeyShortcuts,
  ariaModKey,
  Button,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ColumnsIcon,
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
 * Environments as capsules, not a dropdown, in a strip no wider than they are.
 *
 * ── Why this replaced a `<Select>` ──
 * Switching between dev, staging and production is the single most repeated
 * action on this screen — you compare a value across environments far more often
 * than you do anything else with one. A dropdown costs two clicks and hides the
 * options until the first of them; three capsules cost one click and are legible
 * without any. The old control was correct and slow, in the place where slow is
 * most expensive.
 *
 * ── Three states, and none of them a shade ──
 * A capsule is one of three things, and each is said three ways — a fill or an
 * edge, an icon, and words a screen reader reads:
 *
 *  - **Viewing** — the environment this page is about. A solid fill (the
 *    production colour when it is production) and a tick, `aria-current`.
 *  - **Comparing with** — an environment whose values are shown beside these.
 *    A dashed edge on a raised ground and the columns icon the comparison bar in
 *    the table also wears, and "(comparing)" in its name.
 *  - **Neither** — plain text on the strip.
 *
 * The control this replaces drew "viewing" as a white pill on a near-white
 * strip and "comparing" as a 1px outline, and somebody looking at the row could
 * not tell which environment they were in, let alone which one they had added.
 * The billing toggle went through the same correction for the same reason (see
 * the segmented-control note in `globals.css`): a choice that decides what every
 * value below it means has to be legible at a glance, not inferred from a
 * shadow. While anything is compared, a legend under the row also states it as
 * a sentence — "Viewing Development · Comparing with Staging" — with a way out
 * beside each.
 *
 * ── Compact ──
 * The strip is as wide as the capsules and the Compare button, not as wide as
 * the page. It used to stretch across the whole of it, the button pushed to the
 * far edge and a line under the capsules saying "Viewing Staging · Choose
 * Compare to see another environment's values beside these." on every visit:
 * an offer read once and then stepped over every time after, and a bar of
 * mostly empty strip between the capsules and the thing that acts on them.
 * With nothing compared there is nothing to tell apart — the filled, ticked
 * capsule is where you are, and says so to a screen reader with
 * `aria-current` — so the row is the whole of it; the legend appears only once
 * there is a comparison for it to name.
 *
 * ── Comparing is a button, not a gesture ──
 * "Is this the same value as staging?" is the question the comparison answers:
 * staging's values appear under this environment's, key by key, on the one
 * screen where they can be compared side by side. Nothing is decrypted by the
 * act — the compared listing is masked like any other, and each value is
 * revealed on request through the audited endpoint.
 *
 * It used to be reached by shift-clicking a capsule, which nobody found: a
 * modifier on a pointer gesture is invisible until somebody tells you, and
 * unreachable on a touchscreen. It is now the Compare menu beside the row, which
 * names every other environment as a checkbox, and the legend's × on each
 * compared one. Shift-click is the browser's again — "open in a new window".
 * A plain click on a capsule navigates, as it always did, compared or not.
 *
 * ── Links, not buttons ──
 * Each capsule is an `<a>` to that environment's URL. Middle-click opens
 * production in a new tab; the browser's back button works; the address bar is
 * the truth. A button calling `router.push` would break all three for no gain.
 * The comparison is not in the URL, deliberately — see `compared` on the
 * environment screen for why it is dropped on every navigation.
 *
 * ── Why an overflow menu rather than more capsules ──
 * Three environments is the shape of almost every project, and the default set
 * this product creates. A team with nine would get a row that wraps onto three
 * lines and pushes the table down the page, so the first few stay visible and
 * the rest collapse behind a `⋯`. Which few is not arbitrary — see `visibleSet`.
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
 *    the comparison shown beneath this one. It reaches every environment rather
 *    than only the ones with a capsule. `0` is the tenth, following the tab
 *    convention every browser already teaches. Past the tenth the Compare menu
 *    remains the way in, as it is for the pointer.
 *
 * Navigating and comparing differ only by the mod key, which is right: they are
 * the same question — "what about staging?" — answered by going there or by
 * bringing it here. The Compare menu prints each chord beside its environment.
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
   * Adds an environment to the comparison shown on this page, or takes it out.
   * Absent on screens that have nowhere to show a comparison, which then draw
   * neither the Compare menu nor the legend.
   */
  onCompare?: ((slug: string) => void) | undefined;
  /** Which environments are currently being compared, so their capsules say so. */
  comparing?: ReadonlySet<string> | undefined;
  /** Takes every compared environment off the page at once — "Stop comparing". */
  onStopComparing?: (() => void) | undefined;
  className?: string;
}

/** What a capsule is showing about its environment. See the header. */
export type CapsuleState = 'current' | 'compared' | 'plain';

/**
 * Which of the three a capsule is.
 *
 * The page's own environment is `current` even if a stale set still names it:
 * comparing a page with itself is the one answer nobody needs, and the screen
 * never offers it, so the fill wins rather than two states being drawn at once.
 */
export function capsuleState(
  slug: string,
  currentSlug: string,
  comparing: ReadonlySet<string> | undefined,
): CapsuleState {
  if (slug === currentSlug) return 'current';
  return comparing?.has(slug) === true ? 'compared' : 'plain';
}

/**
 * The environments being compared, in the project's own order.
 *
 * By `sort_order` rather than by the order they were added, so the legend reads
 * "Staging, Production" however the comparison was assembled — the order the
 * capsules above it are in, and the order of the columns in the table below.
 */
export function comparedInOrder(
  environments: readonly Environment[],
  currentSlug: string,
  comparing: ReadonlySet<string> | undefined,
): readonly Environment[] {
  return environments.filter(
    (environment) => capsuleState(environment.slug, currentSlug, comparing) === 'compared',
  );
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
 * shortcuts already teach. An eleventh environment gets no chord; the Compare
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

/**
 * Each state's look. Every capsule carries a border, transparent where it is
 * not the signal, so moving between states never changes a capsule's size and
 * the row does not shuffle under the pointer.
 *
 * The compared edge is `--line-control`, the one line colour measured for
 * SC 1.4.11 against both the strip and the raised ground, rather than a chip's
 * hairline: dashed, it is half the ink of a solid edge, and it still has to be
 * seen. The icon and the legend carry the same fact for anybody who cannot.
 */
function capsuleClass(state: CapsuleState, isProduction: boolean): string {
  return cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors',
    state === 'current' &&
      (isProduction
        ? // Production's own colour, because it is the one environment where
          // acting on the wrong tab costs something different in kind. The
          // `--production-*` pair exists for marking production and nothing
          // else, and the page heading's hatched badge says it in words.
          'bg-production text-production-fg shadow-raised border-transparent'
        : 'bg-accent text-accent-fg shadow-raised border-transparent'),
    state === 'compared' && 'border-line-control bg-surface text-fg border-dashed',
    state === 'plain' && 'text-fg-muted hover:bg-surface hover:text-fg border-transparent',
  );
}

export function EnvironmentSwitcher({
  environments,
  currentSlug,
  href,
  onCreate,
  onCompare,
  comparing,
  onStopComparing,
  className,
}: EnvironmentSwitcherProps) {
  const router = useRouter();
  // `null` until the first commit, which is what keeps the server's markup and
  // the browser's identical — see `useModKey`. The compare caps simply do not
  // draw until then.
  const mod = useModKey();
  const legendId = useId();

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
    // and never for the environment already on screen. Bound for every
    // environment up to the tenth, not just the four with capsules: the chord
    // is the keyboard route that scales past what the row can draw.
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
  const current = environments.find((environment) => environment.slug === currentSlug);
  const compared =
    onCompare === undefined ? [] : comparedInOrder(environments, currentSlug, comparing);

  return (
    <div
      className={cn(
        // `w-fit` rather than the full width of whatever column it sits in —
        // see "Compact" above — and never wider than that column, where the
        // row wraps instead.
        'border-line bg-canvas-inset flex w-fit max-w-full flex-col gap-2 rounded-lg border p-1.5',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* `group` rather than `tablist`: these are links to separate pages,
            not tabs over panels in this document, and announcing them as tabs
            would promise a screen reader user that arrow keys move between
            them without navigating. */}
        <div role="group" aria-label="Environment" className="flex flex-wrap items-center gap-1">
          {visible.map((environment) => {
            const state = capsuleState(environment.slug, currentSlug, comparing);
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
                aria-current={state === 'current' ? 'page' : undefined}
                aria-keyshortcuts={chord === null ? undefined : ariaKeyShortcuts(['Shift', chord])}
                data-state={state}
                {...(state === 'compared' && current !== undefined
                  ? {
                      'aria-description': `Its values are shown beside ${current.name}’s. Opens ${environment.name} on its own.`,
                      title: `${environment.name} is shown beside ${current.name}. Click to open it on its own.`,
                    }
                  : state === 'current'
                    ? { title: `You are viewing ${environment.name}` }
                    : {})}
                className={capsuleClass(state, environment.isProduction)}
              >
                {state === 'current' ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                {state === 'compared' ? <ColumnsIcon className="size-3.5 shrink-0" /> : null}
                {/* Production keeps its dot in every state but the filled one,
                    which is already drawn in production's colour. */}
                {environment.isProduction && state !== 'current' ? (
                  <span
                    aria-hidden="true"
                    className="bg-production inline-block size-1.5 shrink-0 rounded-full"
                  />
                ) : null}
                {environment.name}
                {state === 'compared' ? <span className="sr-only"> (comparing)</span> : null}
                {/* Only on the capsules you are not already on: a cap that goes
                    where you already are is an offer with nothing behind it.
                    Hidden on narrow screens, where the row is tight and there is
                    usually no keyboard to press them with. */}
                {chord !== null && state !== 'current' ? (
                  <Shortcut keys={['Shift', chord]} className="hidden sm:inline-flex" />
                ) : null}
              </Link>
            );
          })}

          {overflow.length > 0 || onCreate ? (
            <MoreEnvironmentsMenu overflow={overflow} href={href} onCreate={onCreate} />
          ) : null}
        </div>

        {onCompare !== undefined && current !== undefined ? (
          <>
            {/* Beside the capsules rather than pushed to the far edge, with a
                rule between: the environments, then what to do with them. */}
            <span aria-hidden="true" className="bg-line hidden h-5 w-px sm:block" />
            <CompareMenu
              environments={environments}
              current={current}
              comparing={comparing}
              compared={compared}
              onCompare={onCompare}
              onStopComparing={onStopComparing}
              mod={mod}
            />
          </>
        ) : null}
      </div>

      {onCompare !== undefined && current !== undefined && compared.length > 0 ? (
        <CompareLegend
          id={legendId}
          current={current}
          compared={compared}
          onCompare={onCompare}
          onStopComparing={onStopComparing}
        />
      ) : null}
    </div>
  );
}

/**
 * The environments past the fourth, and "New environment".
 *
 * Drawn only when it has one of those to offer. It used to be drawn on every
 * page with a comparison too, as the only way into one; with the Compare menu
 * beside the row, a `⋯` over three environments that all fit would be noise.
 */
function MoreEnvironmentsMenu({
  overflow,
  href,
  onCreate,
}: {
  overflow: readonly Environment[];
  href: (slug: string) => string;
  onCreate: (() => void) | undefined;
}) {
  return (
    <DropdownMenu>
      {/* `⋯` alone tells a screen reader user nothing; the count tells them
          whether the menu is worth opening. */}
      <DropdownMenuTrigger
        className="text-fg-subtle hover:text-fg hover:bg-surface data-[state=open]:bg-surface grid size-7 shrink-0 place-items-center rounded-md transition-colors"
        aria-label={
          overflow.length > 0 ? `${overflow.length} more environments` : 'More environment options'
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
  );
}

/**
 * "Compare" — the way into, and out of, the comparison.
 *
 * A visible button with a word on it, where the old way in was a modifier on a
 * click. Its count says how many environments are on the page besides this one
 * without opening anything, and the menu lists every other environment as a
 * checkbox — checkboxes rather than radio items, because several can be on
 * screen at once, so each entry is on or off rather than one being the choice.
 */
function CompareMenu({
  environments,
  current,
  comparing,
  compared,
  onCompare,
  onStopComparing,
  mod,
}: {
  environments: readonly Environment[];
  current: Environment;
  comparing: ReadonlySet<string> | undefined;
  compared: readonly Environment[];
  onCompare: (slug: string) => void;
  onStopComparing: (() => void) | undefined;
  /** The platform's modifier glyph, from `useModKey`; `null` before the first commit. */
  mod: string | null;
}) {
  const count = compared.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          // The visible words first, so a voice-control user saying "click
          // Compare" still lands here (SC 2.5.3); the count after them, which
          // the badge shows and does not say.
          aria-label={
            count === 0
              ? `Compare ${current.name} with another environment`
              : `Compare: ${count} shown beside ${current.name}`
          }
        >
          <ColumnsIcon className="size-4" />
          Compare
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="bg-accent text-accent-fg grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs tabular-nums"
            >
              {count}
            </span>
          ) : null}
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Show beside {current.name}</DropdownMenuLabel>
        {environments.map((environment, index) => {
          if (environment.slug === current.slug) return null;
          // The digit follows the environment's position in the project, so
          // the cap here and the chord that fires are read off the same index
          // — the list is filtered for display only.
          const digit = compareDigit(index);

          return (
            <DropdownMenuCheckboxItem
              key={environment.slug}
              checked={capsuleState(environment.slug, current.slug, comparing) === 'compared'}
              onCheckedChange={() => onCompare(environment.slug)}
              // Kept open, because the point of the list is to turn on more
              // than one. Radix closes a menu on select by default, which would
              // mean reopening it once per environment.
              onSelect={(event) => event.preventDefault()}
              {...(digit === null || mod === null
                ? {}
                : {
                    // The same modifier the cap beside it draws, named as the
                    // attribute's grammar wants it. Hardcoding `Control`
                    // announced a chord a Mac user does not have while the cap
                    // next to it printed ⌘.
                    'aria-keyshortcuts': ariaKeyShortcuts([ariaModKey(mod), 'Shift', digit]),
                  })}
            >
              {environment.isProduction ? (
                <span
                  aria-hidden="true"
                  className="bg-production inline-block size-1.5 shrink-0 rounded-full"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{environment.name}</span>
              {digit !== null && mod !== null ? <Shortcut keys={[mod, 'Shift', digit]} /> : null}
            </DropdownMenuCheckboxItem>
          );
        })}

        {count > 0 && onStopComparing !== undefined ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onStopComparing}>
              <CloseIcon className="size-4" />
              Stop comparing
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The row's states, as a sentence: "Viewing Development · Comparing with
 * Staging ×  Stop comparing".
 *
 * The capsules show the states; this names them, in the same words the Compare
 * button uses, so the two can be matched without a key. Each compared
 * environment carries its own ×, and "Stop comparing" takes them all off at
 * once — both through the screen, which asks first when closing them would
 * discard a value typed into one of their cells.
 *
 * Drawn only while something is compared. It used to be drawn without, as
 * "Viewing Development" and an offer to choose Compare, and that is the line
 * the strip lost to become compact — see the header.
 *
 * Not a live region. The comparison bar above the table already announces
 * which environments are on the page as they change, and two regions saying it
 * would read every change out twice.
 */
function CompareLegend({
  id,
  current,
  compared,
  onCompare,
  onStopComparing,
}: {
  id: string;
  current: Environment;
  compared: readonly Environment[];
  onCompare: (slug: string) => void;
  onStopComparing: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1.5 pb-0.5 text-sm">
      <span className="text-fg-subtle">Viewing</span>
      <span className="text-fg inline-flex items-center gap-1 font-medium">
        <CheckIcon className="size-3.5 shrink-0" />
        {current.name}
      </span>
      <span aria-hidden="true" className="text-fg-subtle">
        ·
      </span>
      <span id={id} className="text-fg-subtle">
        Comparing with
      </span>
      <ul aria-labelledby={id} className="flex flex-wrap items-center gap-1.5">
        {compared.map((environment) => (
          <li
            key={environment.slug}
            className="border-line-control bg-surface text-fg inline-flex items-center gap-1 rounded-md border border-dashed py-0.5 pr-0.5 pl-2 font-medium"
          >
            <ColumnsIcon className="size-3.5 shrink-0" />
            {environment.isProduction ? (
              <span
                aria-hidden="true"
                className="bg-production inline-block size-1.5 shrink-0 rounded-full"
              />
            ) : null}
            {environment.name}
            <button
              type="button"
              onClick={() => onCompare(environment.slug)}
              aria-label={`Stop comparing with ${environment.name}`}
              title={`Stop comparing with ${environment.name}`}
              className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-5 place-items-center rounded transition-colors"
            >
              <CloseIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {onStopComparing !== undefined ? (
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onStopComparing}>
          Stop comparing
        </Button>
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
