'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import { useSettingsHeaderHeight } from './settings-header';
import { SETTINGS_CONTENT_ID, SETTINGS_SECTION_ATTRIBUTE } from './settings-sections';

/** The gap between the sticky header's lower edge and whatever parks below it. */
const GAP_PX = 16;

/**
 * Where the rail parks, and the line the active section is measured against:
 * clear of the application's top bar and of the settings header under it.
 *
 * Two expressions of one number, because the two consumers speak different
 * languages. `top` can be CSS — `var()` and `calc()` both work there, and
 * letting the browser resolve it means the rail moves with the header on the
 * same frame it resizes. `IntersectionObserver`'s `rootMargin` cannot: it takes
 * `px` and `%` only, so that side needs the measurement the header publishes.
 */
const TOP_CSS = `calc(var(--topbar-height) + var(--settings-header-height, 0px) + ${GAP_PX}px)`;

function topbarHeightPx(): number {
  const styles = getComputedStyle(document.documentElement);
  const rem = Number.parseFloat(styles.fontSize) || 16;
  const topbar = styles.getPropertyValue('--topbar-height').trim();

  return topbar.endsWith('rem') ? Number.parseFloat(topbar) * rem : Number.parseFloat(topbar) || 0;
}

interface Section {
  id: string;
  label: string;
}

/**
 * Reads the sections out of the rendered page.
 *
 * Derived from the DOM rather than from a list declared beside the nav, which
 * is the version of this that goes stale: a card added to a tab, renamed, or
 * hidden for somebody whose vault is not set up yet would all need the list
 * editing too, and nothing fails when they do not — the contents just quietly
 * describe a page that no longer exists.
 *
 * The label is the card's own heading, read from the element, for the same
 * reason. `querySelectorAll` returns document order, so the list is in reading
 * order without sorting.
 */
function readSections(container: HTMLElement): Section[] {
  const found: Section[] = [];

  for (const element of container.querySelectorAll<HTMLElement>(
    `[${SETTINGS_SECTION_ATTRIBUTE}][id]`,
  )) {
    const label = element.querySelector('h2, h3')?.textContent?.trim() ?? '';
    if (label.length > 0) found.push({ id: element.id, label });
  }

  return found;
}

function sameSections(a: readonly Section[], b: readonly Section[]): boolean {
  return (
    a.length === b.length &&
    a.every((section, index) => section.id === b[index]?.id && section.label === b[index]?.label)
  );
}

/**
 * The settings area's table of contents: one link per card on the tab you are
 * reading, with the one you are looking at marked.
 *
 * ── Why this exists ──
 * The tab bar above answers "which area", and a tab is one scroll-length of
 * cards — Security alone carries the password, the vault, the lock with
 * passkeys and the device PIN inside it, and every session that can act as the
 * account. Landing on it with a specific question meant scrolling to find the
 * card that answers it, and then scrolling again to check you had not passed
 * something. This turns that into a glance and a click, and gives every card an
 * address worth sending to somebody.
 *
 * ── Why it is not in the flow ──
 * It is absolutely positioned into the left gutter of the centred settings
 * column, so the cards keep the measure and the position they already had: a
 * form that jumped sideways on wide screens the day a contents list arrived
 * would be a worse trade than no contents list. There is only room for it from
 * `xl` up; below that the tab bar is still the whole story, and on a narrow
 * viewport the scroll it saves is the gesture people are most comfortable with
 * anyway.
 *
 * Plain `<a href="#…">` rather than `Link`: a fragment on the current page is
 * a job the browser already does, natively and without the router, including
 * putting the id in the address bar for copying.
 */
export function SettingsToc() {
  const pathname = usePathname();
  const headerHeight = useSettingsHeaderHeight();
  const [sections, setSections] = useState<readonly Section[]>([]);
  const [active, setActive] = useState<string | null>(null);

  // ── Which sections are on the page ──
  //
  // Re-read on every mutation below the content, not once on mount. Half of
  // these cards are not there on the first paint: the vault card waits for the
  // vault, the lock card renders nothing until it knows one is configured, and
  // the devices card is a skeleton until `/api/auth/me` and the session list
  // answer. A one-shot scan would describe the skeleton.
  useEffect(() => {
    const container = document.getElementById(SETTINGS_CONTENT_ID);
    if (container === null) return;

    // An arrow assigned after the null check rather than a hoisted
    // declaration: TypeScript keeps a `const`'s narrowing inside a closure
    // created below the check, but not inside one hoisted above it.
    const sync = () => {
      const next = readSections(container);
      // Compared rather than set unconditionally: this runs on every mutation
      // in a subtree full of forms, and a fresh array each time would re-run
      // the observer effect below — which re-observes every section — for a
      // keystroke in a password field.
      setSections((previous) => (sameSections(previous, next) ? previous : next));
    };

    sync();

    const observer = new MutationObserver(sync);
    // No `characterData`: headings here are literals in the source, and
    // watching text would wake this for every character of every toast,
    // timestamp and validation message on the page.
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);

  // ── Which one you are looking at ──
  //
  // A band across the upper part of the viewport — from just under the top bar
  // to a little under halfway — and the topmost section inside it wins. A tall
  // card spans the whole band and is the only candidate; short ones hand over
  // as they pass the top edge.
  //
  // The previous answer is kept when the band holds nothing, which is what
  // happens mid-flick and at the very bottom of a short page. Marking nothing
  // would make the list blink on every fast scroll.
  useEffect(() => {
    const elements = sections
      .map(({ id }) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const topmost = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (topmost !== undefined) setActive(topmost.target.id);
      },
      // Resolved against the viewport, so the top edge has to clear both sticky
      // bars the sections scroll under — the same line the anchor jump lands on,
      // which `globals.css` gives them as `scroll-margin-top`.
      { rootMargin: `-${topbarHeightPx() + headerHeight + GAP_PX}px 0px -55% 0px` },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
    // Re-observed when the header is re-measured: the band's top edge is that
    // header's lower edge, and an observer built against the old height would
    // hand over to the next section a heading or two early.
  }, [sections, headerHeight]);

  // Nothing to list until the tab's cards are on the page. Every settings tab
  // has more than one section, so the rail is on every one of them — a list
  // that appeared only on the longest tab would read as a glitch on the others.
  if (sections.length === 0) return null;

  // Derived rather than seeded into state, so something is always marked —
  // including before the first scroll, and on a page short enough that nothing
  // ever enters the band. It also drops an `active` left over from the previous
  // tab: switching tabs replaces the sections, and an id that is no longer one
  // of them would highlight nothing at all.
  const currentId = sections.some((section) => section.id === active) ? active : sections[0]?.id;

  return (
    // A column in the flow rather than something floated into the margin, so
    // the rail cannot end up over the cards at any width. Hidden below `xl`,
    // which is the first breakpoint with room for 14rem of rail beside a
    // full-measure form once the application's own sidebar has taken its 15.
    <div className="hidden w-56 shrink-0 xl:block">
      <nav aria-labelledby="settings-toc-heading" className="sticky" style={{ top: TOP_CSS }}>
        <h2
          id="settings-toc-heading"
          className="text-fg-subtle px-3 pb-2 text-[0.6875rem] font-semibold tracking-wider uppercase"
        >
          On this page
        </h2>

        <ul className="border-line-subtle flex flex-col border-l">
          {sections.map((section) => {
            const current = section.id === currentId;
            return (
              <li key={section.id} className="flex">
                <a
                  href={`#${section.id}`}
                  // `location`, not `page`: this marks where you are *within*
                  // the page, and the tab bar above already owns `page`.
                  aria-current={current ? 'location' : undefined}
                  className={cn(
                    '-ml-px block min-w-0 flex-1 border-l-2 py-1.5 pl-3 text-sm transition-colors',
                    current
                      ? 'border-accent text-fg font-medium'
                      : 'text-fg-muted hover:border-line-strong hover:text-fg border-transparent',
                  )}
                >
                  {section.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
