'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { sidebarCollapsedStore } from '@/lib/theme';
import { PanelLeftIcon } from '@/components/ui';
import { PlayxoftMark } from './logo';

export interface NavItem {
  href: string;
  label: string;
  /** A React element rather than a component reference, so a Server Component
   *  can build the nav and hand it across the boundary. */
  icon?: ReactNode;
  /** A count or status chip shown at the trailing edge. */
  badge?: ReactNode;
  /** Highlight only on an exact path match. Use for an index route whose
   *  prefix would otherwise match every page beneath it. */
  exact?: boolean;
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
    <div className={cn('bg-canvas-inset flex h-full min-h-0 flex-col', className)}>
      {header ? <div className="shrink-0 p-3">{header}</div> : null}

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {nav.map((section, sectionIndex) => (
          <div
            key={section.label ?? `section-${sectionIndex}`}
            className={cn(sectionIndex > 0 && 'mt-5')}
          >
            {section.label ? (
              <p className="x-sidebar-wide text-fg-subtle px-2 pb-1.5 text-[0.6875rem] font-medium tracking-wide uppercase">
                {section.label}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      // Spread conditionally rather than passing `undefined`:
                      // `exactOptionalPropertyTypes` treats an explicit
                      // `undefined` as a different thing from an absent prop.
                      {...(onNavigate ? { onClick: onNavigate } : {})}
                      // `aria-current="page"` is the machine-readable half of
                      // the highlight. The colour alone tells a screen reader
                      // user nothing about where they are.
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'x-nav-item relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors',
                        active
                          ? 'bg-surface-active text-fg font-medium'
                          : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                      )}
                    >
                      {item.icon ? (
                        <span
                          aria-hidden="true"
                          className="grid size-4 shrink-0 place-items-center text-base"
                        >
                          {item.icon}
                        </span>
                      ) : null}
                      <span className="x-nav-label min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge ? (
                        <span className="x-sidebar-wide shrink-0">{item.badge}</span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
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
