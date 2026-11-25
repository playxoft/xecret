'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useRef } from 'react';
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
 * ── Two measures, one frame ──
 * A section is a column of fields, and a form stretched across a 27-inch
 * display is a worse form, so a section is held to the 42rem every settings
 * screen has always had. The frame around it is wider, to make room for the
 * nav beside it, and is the same width on every section: the nav does not move
 * sideways when you switch from one to the next. The plans are the exception
 * (`wide`), and take the column's full width for their three columns.
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
  const active = activeSettingsSection(groups, pathname);

  useLegacyAnchors(groups, pathname);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {header}

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-10">
        <SettingsNav label={label} groups={groups} />

        {/* `min-w-0` so a wide child — a table, a long unbroken token — shrinks
            this column instead of pushing the page into a horizontal scroll. */}
        <div className={cn('min-w-0 flex-1', active?.wide ? null : 'max-w-2xl')}>{children}</div>
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
  const groupId = useId();

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
          'relative -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6',
          // The hairline under the row is a shadow inside it, not a border: a
          // border drawn by the links themselves would overlap it by hanging a
          // pixel out of a box that scrolls, and a pixel of vertical overflow
          // in a scrolling box is a vertical scrollbar.
          'shadow-[inset_0_-1px_0_var(--line-subtle)]',
          // The column.
          'xl:mx-0 xl:flex-col xl:gap-5 xl:overflow-visible xl:px-0 xl:shadow-none',
        )}
      >
        {visible.map((group, index) => {
          const headingId = group.label ? `${groupId}-${index}` : undefined;
          return (
            <div key={group.label ?? index} className="flex shrink-0 xl:flex-col">
              {group.label ? (
                <p
                  id={headingId}
                  className="text-fg-subtle hidden px-3 pb-2 text-[0.6875rem] font-semibold tracking-wider uppercase xl:block"
                >
                  {group.label}
                </p>
              ) : null}
              <ul
                aria-labelledby={headingId}
                className="xl:border-line-subtle flex gap-1 xl:flex-col xl:gap-0 xl:border-l"
              >
                {group.sections.map((section) => {
                  const current = section === active;
                  return (
                    <li key={section.href} className="flex shrink-0">
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
                })}
              </ul>
            </div>
          );
        })}
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
