'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { CloseIcon, MenuIcon, SearchIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * The documentation index, as a rail on large screens and a drawer below them.
 *
 * The filter box is a plain substring match over titles, descriptions and
 * frontmatter keywords — no index, no worker, no dependency. Twenty-odd pages
 * do not need a search engine, and shipping one to colour a list of links is
 * how a documentation site ends up slower than the product it documents.
 */

export interface SidebarItem {
  readonly href: string;
  readonly navTitle: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export interface SidebarSection {
  readonly title: string;
  readonly items: readonly SidebarItem[];
}

export function DocsSidebar({ sections }: { sections: readonly SidebarSection[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections;

    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          [item.navTitle, item.description, section.title, ...item.keywords]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [sections, query]);

  const list = (
    <div className="flex flex-col gap-5">
      <label className="relative block">
        <span className="sr-only">Filter documentation</span>
        <SearchIcon className="text-fg-subtle pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter…"
          className="border-line bg-surface text-fg placeholder:text-fg-subtle h-9 w-full rounded-md border pr-3 pl-8 text-sm"
        />
      </label>

      {filtered.length === 0 ? (
        <p className="text-fg-subtle px-1 text-sm">
          Nothing matches “{query.trim()}”. Try <code className="font-mono">token</code>,{' '}
          <code className="font-mono">offline</code> or <code className="font-mono">CI</code>.
        </p>
      ) : (
        filtered.map((section) => (
          <div key={section.title}>
            <h2 className="text-fg-subtle px-2 text-[0.6875rem] font-semibold tracking-wider uppercase">
              {section.title}
            </h2>
            <ul className="mt-1.5 flex flex-col">
              {section.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      // Closes the drawer on the way out. Doing it here rather
                      // than in an effect keyed on the pathname avoids a
                      // cascading render, and covers the case an effect misses:
                      // tapping the page you are already on.
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      title={item.description}
                      className={cn(
                        'block rounded-md px-2 py-1.5 text-sm leading-5 transition-colors',
                        active
                          ? 'bg-accent-tint text-accent-text font-medium'
                          : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                      )}
                    >
                      {item.navTitle}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );

  return (
    <>
      {/* Mobile: a floating trigger rather than a second sticky bar. The header
          above is itself a floating pill with canvas showing around it, and a
          full-width bar tucked under it would scroll text through that gap. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="border-line bg-surface/90 text-fg shadow-overlay fixed bottom-5 left-5 z-40 inline-flex h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium backdrop-blur-xl lg:hidden"
      >
        <MenuIcon className="size-4" />
        Contents
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="bg-overlay absolute inset-0 h-full w-full"
          />
          <div className="bg-canvas border-line absolute inset-y-0 left-0 flex w-[19rem] max-w-[85vw] flex-col border-r">
            <div className="border-line-subtle flex h-16 shrink-0 items-center justify-between border-b px-4">
              <span className="text-fg text-sm font-semibold">Documentation</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="text-fg-muted hover:text-fg grid size-8 place-items-center rounded-md"
              >
                <CloseIcon className="size-4" />
              </button>
            </div>
            <nav aria-label="Documentation" className="flex-1 overflow-y-auto px-4 py-5">
              {list}
            </nav>
          </div>
        </div>
      ) : null}

      {/* Desktop: a sticky rail that scrolls independently of the article. */}
      <nav
        aria-label="Documentation"
        className="border-line-subtle sticky top-[4.5rem] hidden h-[calc(100dvh-5.5rem)] w-64 shrink-0 overflow-y-auto border-r px-4 py-7 lg:block"
      >
        {list}
      </nav>
    </>
  );
}
