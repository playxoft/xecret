'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import type { TocEntry } from '../_lib/markdown';

/**
 * "On this page" — the per-document contents list.
 *
 * The active entry is tracked with an `IntersectionObserver` rather than a
 * scroll handler, so it costs nothing while the reader is not scrolling. The
 * root margin pins the "reading line" a little below the sticky header: without
 * it, a heading counts as read the moment it is technically on screen, which is
 * one section too early for every page.
 */
export function TableOfContents({ entries }: { entries: readonly TocEntry[] }) {
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);

  useEffect(() => {
    if (entries.length === 0) return;

    const headings = entries
      .map((entry) => document.getElementById(entry.id))
      .filter((element): element is HTMLElement => element !== null);

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((record) => record.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-84px 0px -70% 0px', threshold: 0 },
    );

    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [entries]);

  if (entries.length < 2) return null;

  return (
    <nav
      aria-labelledby="on-this-page"
      className="sticky top-[4.5rem] hidden max-h-[calc(100dvh-7rem)] w-56 shrink-0 overflow-y-auto py-7 xl:block"
    >
      <h2
        id="on-this-page"
        className="text-fg-subtle text-[0.6875rem] font-semibold tracking-wider uppercase"
      >
        On this page
      </h2>
      <ul className="border-line-subtle mt-3 flex flex-col border-l">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              aria-current={activeId === entry.id ? 'location' : undefined}
              className={cn(
                '-ml-px block border-l py-1 text-sm leading-5 transition-colors',
                entry.depth === 3 ? 'pl-6' : 'pl-3',
                activeId === entry.id
                  ? 'border-accent text-accent-text font-medium'
                  : 'text-fg-muted hover:text-fg border-transparent',
              )}
            >
              {entry.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The same list, inline above the article, for screens too narrow for the rail.
 *
 * A `<details>` rather than a component with state: it is closed by default,
 * costs no JavaScript, and works before hydration — which on a documentation
 * page opened from a search result is the moment that matters.
 */
export function InlineTableOfContents({ entries }: { entries: readonly TocEntry[] }) {
  if (entries.length < 2) return null;

  return (
    <details className="border-line bg-surface mb-8 rounded-lg border px-4 py-3 xl:hidden">
      <summary className="text-fg cursor-pointer text-sm font-medium">On this page</summary>
      <ul className="mt-3 flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.depth === 3 ? 'pl-4' : undefined}>
            <a href={`#${entry.id}`} className="text-fg-muted hover:text-accent-text text-sm">
              {entry.title}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
