'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { PageHeader } from '@/components/layout';
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { adminTabFromQuery, appPath } from '../_lib/paths';
import type { AdminTab } from '../_lib/paths';
import { AdminsTab } from './admin-admins';
import { AdminGate } from './admin-gate';
import { GrantsTab } from './admin-grants';
import { OrganizationsTab } from './admin-organizations';
import { OverviewTab } from './admin-overview';
import { PromoCodesTab } from './admin-promo-codes';
import { UsersTab } from './admin-users';

export { adminPageState } from './admin-gate';

/**
 * The admin page (`/app/admin`): where xecret's own staff keep an eye on the
 * service — how many accounts, organisations, projects, environments and
 * secrets there are, and every organisation and account newest first — give
 * an organisation a free plan, keep an eye on the ones given, issue promo
 * codes, and say who the other admins are.
 *
 * ── Who sees it ──
 * Admins only, and a 404 for everybody else, before any request is made —
 * `AdminGate`, which the pages for one organisation and one account use too.
 *
 * ── What it shows of a customer ──
 * The account data xecret is responsible for — addresses, names, when people
 * signed up and last signed in — and, of what a customer put in, counts and
 * nothing else. The server never sends a project's, environment's or secret's
 * name, nor anything about a session's device (`schemas/admin.ts`).
 *
 * ── What every change here leaves behind ──
 * A line in the affected organisation's own audit log, attributed to "xecret
 * support" with the admin's reason, which its owners can read — never the
 * admin's own address, which is the server's log line's to keep. The page says
 * so up front, and the grant dialogs ask for the reason that goes with it.
 * Looking leaves nothing there: a read is a line on the server's log only.
 */

export function AdminScreen() {
  return (
    <AdminGate>
      <AdminTabs />
    </AdminGate>
  );
}

function AdminTabs() {
  // The open tab is the address's — `?tab=users` — so the back link of an
  // organisation's or account's page, and the browser's Back, return to the
  // tab it was opened from. Kept in state as well, so a click answers on the
  // same frame; and followed when the address changes under the page (the
  // account menu's "Admin" while a tab is open), React's way to follow a prop.
  const fromAddress = adminTabFromQuery(useSearchParams()?.get('tab'));
  const [tab, setTab] = useState<AdminTab>(fromAddress);
  const [seen, setSeen] = useState<AdminTab>(fromAddress);
  if (fromAddress !== seen) {
    setSeen(fromAddress);
    setTab(fromAddress);
  }

  function choose(value: string) {
    const next = adminTabFromQuery(value);
    // The tab only. `seen` moves when the address does: Next's router applies
    // a native `replaceState` in a transition, after this click's own render,
    // and moving `seen` here would have that render put the old tab back.
    setTab(next);
    // Replaced, not pushed: Back leaves the admin page rather than stepping
    // through every tab looked at.
    window.history.replaceState(null, '', appPath.adminTab(next));
  }

  // Held here rather than in the tabs, so looking at another tab and coming
  // back finds each search where it was left. A tab's request is made again on
  // the way back, which is the point: another tab may have just changed it.
  const [organizationQuery, setOrganizationQuery] = useState<string | null>(null);
  const [userQuery, setUserQuery] = useState<string | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Admin"
        badge={<Badge tone="warning">xecret staff only</Badge>}
        description="The service at a glance, every organisation and account, free plans, promo codes, and who the admins are. Of what customers keep here you see counts only, never what a project, environment or secret is called. Every change to an organisation made here goes in the affected organisation’s audit log as xecret support, with the reason you give, where its owners can read it; looking leaves no trace there. Your own address is not shown to them."
      />

      <Tabs value={tab} onValueChange={choose}>
        <TabsList aria-label="Admin">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="organizations">Organisations</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="grants">Grants</TabsTrigger>
          <TabsTrigger value="promo-codes">Promo codes</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="organizations">
          <OrganizationsTab query={organizationQuery} onSearch={setOrganizationQuery} />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab query={userQuery} onSearch={setUserQuery} />
        </TabsContent>
        <TabsContent value="grants">
          <GrantsTab />
        </TabsContent>
        <TabsContent value="promo-codes">
          <PromoCodesTab />
        </TabsContent>
        <TabsContent value="admins">
          <AdminsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
