'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, isApiError, SIGN_IN_PATH } from '@/lib/api';
import { AppShell, Wordmark } from '@/components/layout';
import type { BreadcrumbItem, ShellOrganization } from '@/components/layout';
import { CreateOrganizationDialog } from '@/components/organizations';
import { Button, EmptyState, PlusIcon, Skeleton, UsersIcon } from '@/components/ui';
import { apiPath, appPath, parseDashboardPath } from '../_lib/paths';
import { useDashboardNav } from './dashboard-nav';
import type { DashboardLocation } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { useAutoLock } from '../_lib/use-auto-lock';
import { useLastVisitedOrg } from '../_lib/use-last-visited-org';
import { ErrorState } from './resource-states';
import { LockScreen } from './lock-screen';
import { SessionProvider } from './session';
import type { MeResponse } from './session';

/**
 * The dashboard's frame: the session, the sidebar, and the breadcrumb trail.
 *
 * ── This is where a signed-out visitor is turned away ──
 * There is no edge guard in front of these routes, by design: one could only
 * check that a cookie is *present*, since validating it needs a database lookup
 * and that would sit in front of every navigation and every prefetch. So the
 * first thing that actually asks the server who this is happens here, and it is
 * `GET /api/auth/me`. An expired, revoked or forged cookie gets a 401, and
 * `lib/api.ts` turns that into a full navigation to the sign-in page. Nothing
 * below renders until the answer is in, so no screen ever mounts against a
 * session that does not exist — and nothing here is a security boundary either
 * way: every byte of data on these pages comes from `/api/**`, which
 * authenticates and authorises each request on its own.
 */
export function DashboardChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const location = useMemo(() => parseDashboardPath(pathname), [pathname]);
  const session = useApiResource<MeResponse>(apiPath.me());

  // Owned here, and only here, because the thing that has to change when an
  // organisation is created is *this* component's session resource — the
  // membership list every part of the shell is drawn from. Four components used
  // to mount their own dialog and wire their own refresh; the two screens below
  // the shell now open this one through `useSession().createOrganization`, so
  // the behaviour after a successful create is written once.
  const [creatingOrg, setCreatingOrg] = useState(false);
  const openCreateOrganization = useCallback(() => setCreatingOrg(true), []);

  // ── Which organisation the shell describes when the URL names none ──
  //
  // The account area — `/app/settings/*` — has no organisation in its path, and
  // neither does the organisation picker. The sidebar used to empty itself out
  // on those routes, which rearranged the shell underneath somebody who only
  // opened their own settings; it now keeps describing an organisation. Which
  // one matters more than it looks: every sidebar href, the switcher's label
  // and the admin gate are computed from this one slug, so naming the wrong
  // organisation sends "Projects" into a different tenant. See the note in
  // `use-last-visited-org.ts` for why the first membership is not that answer.
  //
  // The remembered slug is only honoured if it is still a membership, so an
  // organisation the viewer has been removed from cannot outlive their access
  // to it. A cold load with nothing remembered falls back to the first
  // membership — the shell has to name something, and there is nothing better
  // to know at that point.
  const lastVisitedOrgSlug = useLastVisitedOrg(location.orgSlug);
  const memberships = session.data?.organizations;
  const navOrgSlug =
    location.orgSlug ??
    memberships?.find((organization) => organization.slug === lastVisitedOrgSlug)?.slug ??
    memberships?.[0]?.slug ??
    null;

  // Built before the early returns below, because hooks cannot run
  // conditionally. It issues no request until there is an organisation in the
  // *URL* — `projectsOrgSlug`, not the resolved slug — so the loading and
  // locked paths, and the account area, cost nothing extra. The role is
  // threaded in from the session resource because this runs above the
  // SessionProvider, and is read for the same organisation the hrefs are built
  // from, so the admin-only items can never describe one organisation's role
  // over another's links.
  const viewerRole =
    memberships?.find((organization) => organization.slug === navOrgSlug)?.role ?? null;
  const nav = useDashboardNav({
    ...location,
    orgSlug: navOrgSlug,
    projectsOrgSlug: location.orgSlug,
    viewerRole,
  });

  // Locking re-reads the session, which re-renders this component and lands on
  // the lock screen. One code path for "we are locked", whether that came from
  // the menu or from an eight-hour timeout.
  const reloadSession = session.reload;
  const lock = useCallback(async () => {
    await api.post('/auth/pin/lock');
    reloadSession();
  }, [reloadSession]);

  // The idle lock. Armed only while there is an unlock to lose; the interval
  // comes from the account's setting on the security page, `0` disarms it.
  const pinState = session.data?.pin;
  useAutoLock(
    pinState?.autoLockMinutes ?? 0,
    pinState?.configured === true && pinState.unlocked,
    lock,
  );

  // Built once and rendered in whichever branch below is reached — never in two
  // at the same time. An element rather than a second `<CreateOrganizationDialog>`
  // call site, so a prop added to it is added in one place.
  const createOrganizationDialog = (
    <CreateOrganizationDialog
      open={creatingOrg}
      onOpenChange={setCreatingOrg}
      onCreated={reloadSession}
    />
  );

  if (session.loading) return <ChromeSkeleton />;

  if (session.error !== null || session.data === null) {
    // `lib/api.ts` has already started a full navigation to the sign-in page for
    // a 401. Rendering an error card here would flash a failure at somebody
    // whose session merely expired, so this says what is happening instead.
    if (isApiError(session.error) && session.error.code === 'unauthenticated') {
      return <ChromeNotice>Your session has ended. Taking you to sign in…</ChromeNotice>;
    }

    return (
      <ChromeFrame>
        <ErrorState subject="your account" error={session.error} onRetry={session.reload} />
      </ChromeFrame>
    );
  }

  const { user, organizations, pin } = session.data;

  // ── The lock, before anything else the shell would render ──
  //
  // Not a security boundary: every gated route refuses a locked session on its
  // own, so a client that skipped this would simply get a page of 403s. It is
  // here because a dashboard of empty tables and error toasts is a far worse
  // way to learn you are locked than being told.
  //
  // Checked before the "no organisations" case below, because a locked session
  // has not yet earned an explanation of its membership.
  if (!pin.configured || !pin.unlocked) {
    return <LockScreen status={pin} email={user.email} onUnlocked={session.reload} />;
  }

  if (organizations.length === 0) {
    // An organisation is created at first sign-in (`POST /api/auth/session`), so
    // this is reachable only once every membership is gone — removed by someone
    // else, or deleted by this account itself on the organisation settings page.
    //
    // Starting a new one is offered first, and it is the reason this screen is
    // not a dead end: without it, an owner who deleted their last organisation
    // would be left on a page whose only way forward is to be invited by
    // somebody else.
    return (
      <ChromeFrame>
        <EmptyState
          icon={<UsersIcon />}
          title="You are not a member of any organisation"
          description="Create one to start again, ask an owner to invite you back, or sign in with a different account."
          action={
            <Button variant="primary" onClick={openCreateOrganization}>
              <PlusIcon className="size-4" />
              New organisation
            </Button>
          }
          secondaryAction={
            <Button variant="secondary" asChild>
              <a href={SIGN_IN_PATH}>Sign in with a different account</a>
            </Button>
          }
        />
        {createOrganizationDialog}
      </ChromeFrame>
    );
  }

  // Resolved through `navOrgSlug` rather than repeating its fallback, so the
  // switcher and the sidebar always name the same organisation. The two
  // disagreeing would be worse than either of them being wrong on its own —
  // a sidebar full of Zebra's links under a switcher reading "Acme" is a shell
  // that cannot be trusted about where you are.
  //
  // The `?? organizations[0]` below is reached only when the URL names an
  // organisation the viewer is not a member of — a typed or stale link, where
  // the switcher has nothing truthful to show and `resolveOrg` answers the page
  // behind it with a 404 regardless. It is not the account-area fallback; that
  // one has already been applied above.
  const currentOrg =
    organizations.find((organization) => organization.slug === navOrgSlug) ?? organizations[0];

  const shellOrganizations: readonly ShellOrganization[] = organizations.map((organization) => ({
    slug: organization.slug,
    name: organization.name,
    role: organization.role,
    href: appPath.org(organization.slug),
  }));

  return (
    <SessionProvider
      value={{
        user,
        organizations,
        pin,
        lock,
        refresh: reloadSession,
        createOrganization: openCreateOrganization,
      }}
    >
      <AppShell
        nav={nav}
        organizations={shellOrganizations}
        currentOrgSlug={currentOrg?.slug ?? ''}
        onCreateOrganization={openCreateOrganization}
        user={{ name: user.displayName ?? user.email, email: user.email }}
        accountHref={appPath.account()}
        onLock={lock}
        breadcrumbs={buildBreadcrumbs(location, currentOrg?.name ?? null)}
      >
        {children}
      </AppShell>

      {/* Outside `AppShell` rather than inside the sidebar: the dialog is
          portalled to the document either way, and keeping it here means the
          mobile drawer closing does not unmount a form somebody is typing in.
          Inside the provider, so every screen below can open it. */}
      {createOrganizationDialog}
    </SessionProvider>
  );
}

/**
 * The trail down the tenancy chain.
 *
 * It stops at the deepest resource in the URL rather than naming the page: each
 * screen's `<h1>` already does that, and a crumb repeating it would say the same
 * word twice in a row. The organisation appears under its display name because
 * that is the one label the shell already knows; everything below it is a slug,
 * for the same reason the sidebar uses slugs.
 */
function buildBreadcrumbs(
  location: DashboardLocation,
  orgName: string | null,
): readonly BreadcrumbItem[] {
  const { orgSlug, projectSlug, envSlug, isAccountArea } = location;

  if (isAccountArea) return [{ label: 'Account' }];
  if (orgSlug === null) return [{ label: 'Organisations' }];

  const crumbs: BreadcrumbItem[] = [{ label: orgName ?? orgSlug, href: appPath.org(orgSlug) }];
  if (projectSlug === null) return crumbs;

  crumbs.push({ label: projectSlug, href: appPath.project(orgSlug, projectSlug) });
  if (envSlug === null) return crumbs;

  crumbs.push({ label: envSlug, href: appPath.environment(orgSlug, projectSlug, envSlug) });
  return crumbs;
}

/** The shell's own loading state: the frame, without the parts that need a session. */
function ChromeSkeleton() {
  return (
    <div className="bg-canvas flex min-h-dvh" aria-busy="true" aria-label="Loading xecret">
      <aside className="x-sidebar bg-canvas-inset border-line hidden shrink-0 border-r p-3 md:block">
        <Skeleton className="h-10 w-full" />
        <div className="mt-6 space-y-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-line flex h-[var(--topbar-height)] shrink-0 items-center border-b px-4 sm:px-6">
          <Skeleton className="h-4 w-40" />
        </header>
        <div className="px-4 py-8 sm:px-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="mt-4 h-4 w-80" />
        </div>
      </div>
    </div>
  );
}

/** A bare frame for the two states where there is no session to build a shell from. */
function ChromeFrame({ children }: { children: ReactNode }) {
  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <header className="border-line flex h-[var(--topbar-height)] shrink-0 items-center border-b px-4 sm:px-6">
        <Wordmark />
      </header>
      <main className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">{children}</main>
    </div>
  );
}

function ChromeNotice({ children }: { children: ReactNode }) {
  return (
    <ChromeFrame>
      {/* Announced politely: the navigation is already under way, and
          interrupting a screen reader to say so would arrive after the fact. */}
      <p role="status" className="text-fg-muted text-sm">
        {children}
      </p>
      <Button variant="secondary" size="sm" className="mt-4" asChild>
        <a href={SIGN_IN_PATH}>Go to sign in</a>
      </Button>
    </ChromeFrame>
  );
}
