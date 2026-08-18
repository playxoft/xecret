'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { sidebarCollapsedStore } from '@/lib/theme';
import { ariaKeyShortcuts, ChevronRightIcon, PanelLeftIcon, Shortcut } from '@/components/ui';
import { PlayxoftMark } from './logo';

export interface NavItem {
  href: string;
  label: string;
  /** A React element rather than a component reference, so a Server Component
   *  can build the nav and hand it across the boundary. */
  icon?: ReactNode;
  /** A count or status chip shown at the trailing edge. */
  badge?: ReactNode;
  /**
   * A chord that navigates here, as key caps at the trailing edge — `['G']`,
   * `['Shift', '1']`.
   *
   * Declaring it is what *creates* the shortcut: `useNavShortcuts` in
   * `app-shell.tsx` walks this same nav tree to build its key map, so a cap
   * can never be drawn for a chord that does nothing, and a chord can never
   * exist without a cap advertising it. See that hook for what it refuses to
   * fire on.
   */
  shortcut?: readonly string[];
  /** Highlight only on an exact path match. Use for an index route whose
   *  prefix would otherwise match every page beneath it. */
  exact?: boolean;
  /**
   * Nested items, revealed by a disclosure triangle beside the label.
   *
   * One level deep, and deliberately not more. The tenancy chain is
   * organisation → project → environment; the organisation is already the
   * switcher at the top of this panel, and environments belong to the screens
   * that compare them rather than to a third row of truncated labels in a
   * 240px column. So "Projects" and the projects under it is the whole of it.
   */
  children?: readonly NavItem[];
}

export interface NavSection {
  label?: string;
  items: readonly NavItem[];
}

export interface SidebarProps {
  nav: readonly NavSection[];
  /** Rendered above the navigation — the organisation switcher. */
  header?: ReactNode;
  /** Desktop only. The mobile drawer is dismissed instead of collapsed. */
  collapsible?: boolean;
  /** Called after a nav link is activated, so the mobile drawer can close. */
  onNavigate?: () => void;
  className?: string;
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function Sidebar({ nav, header, collapsible = false, onNavigate, className }: SidebarProps) {
  const pathname = usePathname();

  // The visual collapse is driven entirely by `<html data-sidebar>`, which the
  // inline bootstrap script sets before first paint — so the width is never
  // wrong, even for one frame. This value exists only so the toggle can report
  // `aria-expanded` honestly, and it is read as an external store because that
  // is where it actually lives.
  const collapsed = useSyncExternalStore(
    sidebarCollapsedStore.subscribe,
    sidebarCollapsedStore.getSnapshot,
    sidebarCollapsedStore.getServerSnapshot,
  );

  return (
    // The sidebar shares the canvas rather than sitting on its own tinted
    // panel. With the neutrals gone grey there is no tint left that reads as
    // "chrome" instead of "a different kind of content", so the hairline on
    // the shell's edge does the separating — one line instead of a slab.
    <div className={cn('bg-canvas flex h-full min-h-0 flex-col', className)}>
      {header ? <div className="shrink-0 p-3">{header}</div> : null}

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {nav.map((section, sectionIndex) => (
          <div
            key={section.label ?? `section-${sectionIndex}`}
            className={cn(sectionIndex > 0 && 'mt-6')}
          >
            {section.label ? (
              // Small, letterspaced and quiet. A section heading in a 240px
              // column competes with the items under it at any weight that
              // also has size; this one gives up size to keep the weight.
              <p className="x-sidebar-wide text-fg-subtle px-2 pb-2 text-xs font-medium tracking-[0.06em] uppercase">
                {section.label}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <NavEntry
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  depth={0}
                  {...(onNavigate ? { onNavigate } : {})}
                />
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-line-subtle flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2.5">
        <PlayxoftMark className="x-sidebar-wide" />
        {collapsible ? (
          <button
            type="button"
            onClick={() => sidebarCollapsedStore.set(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            // The server snapshot is "expanded"; the client snapshot is the
            // stored value. Suppressed because only attributes differ — the
            // icon is deliberately identical in both states, so React has no
            // element-level mismatch to recover from.
            suppressHydrationWarning
            className="text-fg-subtle hover:bg-surface-hover hover:text-fg grid size-7 shrink-0 place-items-center rounded-md transition-colors"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One row, and its children when it has any.
 *
 * ── Why the disclosure and the link are separate controls ──
 * A parent row does two things: it navigates to itself, and it expands to show
 * what is under it. Merging them means one of the two is unreachable — either
 * clicking the name cannot open the page, or it cannot expand without leaving
 * the page you are on. So the triangle is its own button, with its own
 * accessible name, and the label beside it stays an ordinary link.
 *
 * ── Folding ──
 * A parent starts open, always. The projects under "Projects" are the thing
 * this sidebar is mostly *for*, and hiding them until you are already inside
 * one inverts that: the list you navigate with is only visible once you no
 * longer need it to navigate.
 *
 * This used to open a parent only when the current page was inside it, so the
 * tree folded and unfolded as you moved. That is a reasonable default for a
 * deep tree; it is the wrong one here, where the tree is a single level and
 * short enough to show whole.
 *
 * Collapsing is still available and still sticky — once the triangle is
 * touched, that choice outranks the default for as long as the row is
 * mounted, including while you are inside the branch you just closed. A
 * sidebar that re-opens something you deliberately shut is worse than one
 * that never folded at all.
 */
function NavEntry({
  item,
  pathname,
  depth,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  depth: number;
  onNavigate?: () => void;
}) {
  const children = item.children ?? [];
  const hasChildren = children.length > 0;

  // `null` means "nobody has touched the triangle", which is what makes the
  // default below a default rather than an initial value: it keeps applying
  // until the user actually expresses a preference, and their preference then
  // survives every subsequent navigation.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? true;

  const active = isActive(pathname, item);

  return (
    <li>
      <div className="relative flex items-center">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
            className="text-fg-subtle hover:bg-surface-hover hover:text-fg absolute left-0 z-10 grid size-5 shrink-0 place-items-center rounded transition-colors"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
        ) : null}

        <Link
          href={item.href}
          // Spread conditionally rather than passing `undefined`:
          // `exactOptionalPropertyTypes` treats an explicit `undefined` as a
          // different thing from an absent prop.
          {...(onNavigate ? { onClick: onNavigate } : {})}
          // `aria-current="page"` is the machine-readable half of the highlight.
          // The colour alone tells a screen reader user nothing.
          aria-current={active ? 'page' : undefined}
          // …and this is the machine-readable half of the key caps, which are
          // `aria-hidden`. See `ariaKeyShortcuts`.
          aria-keyshortcuts={
            item.shortcut && item.shortcut.length > 0 ? ariaKeyShortcuts(item.shortcut) : undefined
          }
          className={cn(
            'x-nav-item relative flex h-9 min-w-0 flex-1 items-center gap-3 rounded-lg pr-2 text-sm transition-colors',
            hasChildren ? 'pl-6' : 'pl-2',
            // `--surface-active` for the current page, `--surface-hover` for a
            // row under the pointer. Sharing one fill made "you are here"
            // reproducible by moving the mouse: every row became the current
            // row on hover, and the only thing left telling them apart was the
            // font weight. Deliberately no hover step on the active row — it
            // already sits at the top of the neutral fill ramp, so anything a
            // hover could add would have to come back *down* and collide with
            // the hovered-inactive fill again.
            active
              ? 'bg-surface-active text-fg font-medium'
              : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
          )}
        >
          {item.icon ? (
            <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-base">
              {item.icon}
            </span>
          ) : null}
          <span className="x-nav-label min-w-0 flex-1 truncate">{item.label}</span>
          {item.badge ? <span className="x-sidebar-wide shrink-0">{item.badge}</span> : null}
          {item.shortcut && item.shortcut.length > 0 ? (
            // `x-sidebar-wide` hides it along with the label when the rail is
            // collapsed: a column of bare key caps with nothing to name them
            // is furniture, not a hint.
            //
            // Always visible rather than revealed on hover, because the whole
            // point of the cap is to be read by somebody who was not looking
            // for it — a hint you have to hover to find teaches nobody.
            <Shortcut keys={item.shortcut} className="x-sidebar-wide" />
          ) : null}
        </Link>
      </div>

      {hasChildren && open ? (
        // The rule is a guide line, not decoration: at this indent the eye
        // cannot otherwise tell which parent a child belongs to once two
        // projects are open at once.
        <ul
          className={cn(
            'border-line-subtle x-sidebar-wide mt-0.5 flex flex-col gap-0.5 border-l pl-2',
            depth === 0 ? 'ml-[0.6875rem]' : 'ml-3',
          )}
        >
          {children.map((child) => (
            <NavEntry
              key={child.href}
              item={child}
              pathname={pathname}
              depth={depth + 1}
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
