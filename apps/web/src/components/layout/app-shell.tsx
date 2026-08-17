'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { MenuIcon } from '@/components/ui';
import { Breadcrumbs } from './breadcrumbs';
import type { BreadcrumbItem } from './breadcrumbs';
import { Wordmark } from './logo';
import { OrgSwitcher } from './org-switcher';
import type { ShellOrganization } from './org-switcher';
import { Sidebar } from './sidebar';
import type { NavSection } from './sidebar';
import { UserMenu } from './user-menu';
import type { ShellUser } from './user-menu';

export interface AppShellProps {
  nav: readonly NavSection[];
  organizations: readonly ShellOrganization[];
  currentOrgSlug: string;
  /**
   * Adds "New organisation" to the organisation switcher's menu.
   *
   * A callback rather than an href because creating one is a dialog, not a
   * page — see `CreateOrganizationDialog` for why. The shell does not own that
   * dialog: it lives with the session it has to refresh afterwards.
   */
  onCreateOrganization?: () => void;
  user: ShellUser;
  accountHref?: string;
  /** Locks the session without ending it. Adds "Lock now" to the account menu. */
  onLock?: () => Promise<void>;
  breadcrumbs?: readonly BreadcrumbItem[];
  /** Top-bar controls to the left of the account menu — search, quick create. */
  topBarActions?: ReactNode;
  children: ReactNode;
}

/**
 * Sidebar, top bar, content.
 *
 * Below `md` the sidebar becomes a modal drawer. It is the same `Sidebar`
 * component in both places — a second, mobile-only navigation is a second
 * thing to keep in sync, and it is always the one that goes stale.
 */
export function AppShell({
  nav,
  organizations,
  currentOrgSlug,
  onCreateOrganization,
  user,
  accountHref,
  onLock,
  breadcrumbs,
  topBarActions,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // A link inside the drawer navigates without unmounting the shell, so the
  // drawer has to be told to close. Comparing against the previous pathname
  // during render — React's documented way to adjust state when a prop changes
  // — also covers back and forward navigation, which no click handler sees. An
  // effect would work too, but it would close the drawer a frame later, after
  // the new page has already painted behind it.
  const [renderedPathname, setRenderedPathname] = useState(pathname);
  if (pathname !== renderedPathname) {
    setRenderedPathname(pathname);
    setDrawerOpen(false);
  }

  /**
   * The switcher, built per placement rather than once.
   *
   * The drawer's copy has to dismiss the drawer before opening the create
   * dialog: a dialog raised *behind* an open navigation drawer leaves the user
   * looking at the sidebar they were trying to leave. The desktop sidebar has
   * nothing to dismiss, so it passes `false`.
   */
  function sidebarHeader(inDrawer: boolean) {
    const create =
      onCreateOrganization === undefined
        ? undefined
        : () => {
            if (inDrawer) setDrawerOpen(false);
            onCreateOrganization();
          };

    return (
      <OrgSwitcher
        organizations={organizations}
        currentSlug={currentOrgSlug}
        {...(create ? { onCreate: create } : {})}
      />
    );
  }

  return (
    <div className="bg-canvas flex min-h-dvh">
      {/* The first thing a keyboard user reaches. Without it, every page starts
          with a full pass through the sidebar before the content. */}
      <a
        href="#main-content"
        className="bg-surface text-fg border-line sr-only z-50 rounded-md border px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside className="x-sidebar border-line sticky top-0 hidden h-dvh shrink-0 border-r md:block">
        <Sidebar nav={nav} header={sidebarHeader(false)} collapsible />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-line bg-canvas/85 sticky top-0 z-30 flex h-[var(--topbar-height)] shrink-0 items-center gap-3 border-b px-4 backdrop-blur-sm sm:px-6">
          <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogPrimitive.Trigger
              className="text-fg-muted hover:bg-surface-hover hover:text-fg -ml-1 grid size-8 shrink-0 place-items-center rounded-md transition-colors md:hidden"
              aria-label="Open navigation"
            >
              <MenuIcon className="size-5" />
            </DialogPrimitive.Trigger>

            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="bg-overlay data-[state=open]:animate-enter data-[state=closed]:animate-exit fixed inset-0 z-50 md:hidden" />
              <DialogPrimitive.Content
                className="border-line bg-canvas-inset fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col border-r data-[state=closed]:animate-[slide-out-left_140ms_ease-in] data-[state=open]:animate-[slide-in-left_180ms_cubic-bezier(0.16,1,0.3,1)] md:hidden"
                aria-label="Navigation"
              >
                {/* Radix requires a title for the dialog's accessible name; it
                    is hidden because the drawer's purpose is obvious visually. */}
                <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
                <div className="border-line-subtle flex h-[var(--topbar-height)] shrink-0 items-center border-b px-3">
                  <Wordmark />
                </div>
                <div className="min-h-0 flex-1">
                  <Sidebar
                    nav={nav}
                    header={sidebarHeader(true)}
                    onNavigate={() => setDrawerOpen(false)}
                  />
                </div>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          {breadcrumbs && breadcrumbs.length > 0 ? (
            <Breadcrumbs items={breadcrumbs} className="flex-1" />
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex shrink-0 items-center gap-2">
            {topBarActions}
            <UserMenu
              user={user}
              {...(accountHref === undefined ? {} : { accountHref })}
              {...(onLock === undefined ? {} : { onLock })}
            />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
