'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import {
  activeSettingsSection,
  legacyAnchorTarget,
  visibleSettingsGroups,
} from './settings-sections';
import type { SettingsSectionGroup } from './settings-sections';

/**
 * The frame every settings area shares — the account's, an organisation's and
 * an environment's — so the three look and behave as one thing.
 *
 * The area's heading on top; under it, the list of the area's sections beside
 * whichever one is open, and only that one. See `settings-sections.ts` for why
 * each section is a route, and for the lists themselves.
 *
 * ── One width, on every section ──
 * Moving from one section to the next changes what is in the column and
 * nothing about where it is. The column used to have two widths — the 42rem
 * every form was held to, and the whole of it for the plans — and opening
 * Plans widened the page under the pointer and leaving it narrowed it again,
 * which reads as the page jumping however reasonable each width is alone.
 *
 * So the column is sized for the widest section and every section has it:
 * the frame's 72rem, less the nav's 13 and the gap's 2.5, leaves 56.5rem —
 * room for the plans' three columns side by side, which want 56 (`@4xl` in
 * `upgrade-screen.tsx`), and for their comparison table's 52 whole. The frame
 * is that one width for the same reason: it is centred, so a frame that grew
 * for one section would start further left on it, and the list somebody had
 * just clicked in would slide sideways. `settings-layout.test.ts` does the
 * arithmetic, so a wider nav or a narrower frame that would squeeze the plans
 * again fails there.
 *
 * What the width is wrong for is a field: a name box stretched across 56rem,
 * and a hint read in one 120-character line under it. So the fields keep the
 * 42rem measure they always had — every `Field` carries `data-field` for the
 * purpose — while the cards around them, and the tables and lists that are
 * glad of the room, take the column.
 *
 * The last thing that moved the frame sideways was the page's own scrollbar,
 * there beside a long section and gone beside a short one, which shifted
 * everything centred by half its width. The root keeps the scrollbar's gutter
 * whether or not there is anything to scroll — see `scrollbar-gutter` in
 * `globals.css`.
 *
 * ── The nav beside the content, or above it ──
 * Beside it from `xl`, the first breakpoint with room for the nav next to a
 * full-measure form once the application's own sidebar has taken its 15rem —
 * the same reckoning the contents rail this replaces was placed by. Below
 * that, the same links run in one row above the section, scrolling sideways
 * when they do not fit, which is the narrow-screen form of a list somebody
 * reads left to right.
 */
export function SettingsLayout({
  header,
  label,
  groups,
  children,
}: {
  /** The area's `PageHeader` — the page's one `<h1>`, the same on every section. */
  header: ReactNode;
  /** The nav's accessible name: "Account settings", "Organisation settings". */
  label: string;
  /**
   * Every section of the area, hidden ones included: those are left out of the
   * nav but still forwarded to. Memoise it — it is an effect's dependency.
   */
  groups: readonly SettingsSectionGroup[];
  children: ReactNode;
}) {
  const pathname = usePathname();

  useLegacyAnchors(groups, pathname);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      {header}

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-10">
        <SettingsNav label={label} groups={groups} />

        {/* The same column on every section, its fields held to a form's
            measure — see the header. `min-w-0` so a wide child — a table, a
            long unbroken token — shrinks this column instead of pushing the
            page into a horizontal scroll. */}
        <div className="min-w-0 flex-1 [&_[data-field]]:max-w-2xl">{children}</div>
      </div>
    </div>
  );
}

/**
 * The list of an area's sections, with the one you are on marked.
 *
 * Links rather than a client-side `<Tabs>`, for the reason the tab bar it
 * replaces gave: each section is a route, so "where do I change my
 * passphrase?" has an address that can be sent to someone. The current one is
 * derived from the pathname, which is what makes this a nav and not state, and
 * marked with `aria-current="page"` as well as colour — and with a bar beside
 * it, so the mark survives greyscale and colour-vision deficiency.
 *
 * ── One plain list ──
 * Every section of the area in one list, in order, with no headings over
 * parts of it. The column used to print its groups' names — "Security",
 * "Plan and billing" — above them, and with a handful of sections, each named
 * for what it holds, a heading was one more line to read past on the way to
 * the link it introduced. A group is now only a little space in the column
 * before the next one, which is what still sets Danger zone apart from the
 * sections above it; the row runs them together, as it always did.
 *
 * Exported for its test; the frame above is what screens render.
 */
export function SettingsNav({
  label,
  groups,
}: {
  label: string;
  groups: readonly SettingsSectionGroup[];
}) {
  const pathname = usePathname();
  const active = activeSettingsSection(groups, pathname);
  const visible = visibleSettingsGroups(groups);
  const scroller = useRef<HTMLDivElement>(null);

  // ── Keeping the current section in view on a narrow screen ──
  //
  // The row scrolls, and the section you are on can be past its right edge —
  // Danger zone, always last, almost always is. A list that loads with the
  // current item out of sight answers "where am I?" with nothing, so the row
  // is scrolled to show it. Sideways only, by hand rather than with
  // `scrollIntoView`: that would also scroll the page to bring the row into
  // view, underneath somebody who had already moved on. In the vertical list
  // nothing overflows and this does nothing.
  useEffect(() => {
    const row = scroller.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current || row.scrollWidth <= row.clientWidth) return;

    // `offsetLeft` is measured from the row, which is positioned for the
    // purpose. The inset keeps the item clear of the row's own edge padding.
    const inset = 16;
    const start = current.offsetLeft;
    const end = start + current.offsetWidth;
    if (start - inset < row.scrollLeft) row.scrollLeft = Math.max(0, start - inset);
    else if (end + inset > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = end + inset - row.clientWidth;
    }
  }, [pathname]);

  return (
    <nav
      aria-label={label}
      // Parked under the top bar from `xl`, where it is a column beside the
      // section: a section a screen and a half long should not take the way to
      // the others with it. Above the section it scrolls away like everything
      // else — the row is one line, and the section is right under it.
      className="xl:sticky xl:top-[calc(var(--topbar-height)+1.5rem)] xl:w-52 xl:shrink-0"
    >
      <div
        ref={scroller}
        data-scroll-region=""
        className={cn(
          // The row: one line, scrolling sideways, bled to the edges of the
          // page's gutter so the links scroll under it rather than stopping
          // short of it. `relative` is what `offsetLeft` above is measured from.
          'relative -mx-4 flex overflow-x-auto px-4 sm:-mx-6 sm:px-6',
          // The hairline under the row is a shadow inside it, not a border: a
          // border drawn by the links themselves would overlap it by hanging a
          // pixel out of a box that scrolls, and a pixel of vertical overflow
          // in a scrolling box is a vertical scrollbar.
          'shadow-[inset_0_-1px_0_var(--line-subtle)]',
          // The column.
          'xl:mx-0 xl:flex-col xl:overflow-visible xl:px-0 xl:shadow-none',
        )}
      >
        <ul className="xl:border-line-subtle flex gap-1 xl:flex-col xl:gap-0 xl:border-l">
          {visible.flatMap((group, groupIndex) =>
            group.sections.map((section, index) => {
              const current = section === active;
              return (
                <li
                  key={section.href}
                  // The space before a group, in the column: the only trace of
                  // the groups left in the list.
                  className={cn('flex shrink-0', groupIndex > 0 && index === 0 && 'xl:mt-3')}
                >
                  <Link
                    href={section.href}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'block border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
                      'xl:-ml-px xl:min-w-0 xl:flex-1 xl:border-b-0 xl:border-l-2 xl:py-1.5 xl:pr-2 xl:pl-3 xl:whitespace-normal',
                      current
                        ? 'border-accent text-fg font-medium'
                        : 'text-fg-muted hover:text-fg xl:hover:border-line-strong border-transparent',
                    )}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            }),
          )}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Sends a visit carrying a fragment from before the sections had addresses on
 * to the section that holds that card now — `…/settings/security#devices` to
 * Signed-in devices. See `legacyAnchorTarget` for why the fragment has to be
 * read here rather than by a redirect.
 *
 * Read on arrival and on every `hashchange`: a fragment typed into the address
 * bar of a page already open is no page load, and nothing else would notice
 * it. `replace`, because the address with the old fragment is not one anybody
 * wants to come back to — Back from the section should go to where they were
 * before they followed the link.
 */
function useLegacyAnchors(groups: readonly SettingsSectionGroup[], pathname: string): void {
  const router = useRouter();

  useEffect(() => {
    const forward = () => {
      const target = legacyAnchorTarget(groups, pathname, window.location.hash);
      if (target !== null) router.replace(target);
    };

    forward();
    window.addEventListener('hashchange', forward);
    return () => window.removeEventListener('hashchange', forward);
  }, [groups, pathname, router]);
}
