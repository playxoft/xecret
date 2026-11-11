'use client';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useState } from 'react';

import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  EmptyState,
  ShieldIcon,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { appPath } from '../_lib/paths';
import { AdminsTab } from './admin-admins';
import { GrantsTab } from './admin-grants';
import { OrganizationsTab } from './admin-organizations';
import { PromoCodesTab } from './admin-promo-codes';
import { useSession } from './session';

/**
 * The admin page (`/app/admin`): where xecret's own staff give an organisation
 * a free plan, keep an eye on the ones given, issue promo codes, and say who
 * the other admins are.
 *
 * ── Who sees it ──
 * Whoever `/api/auth/me` says is an admin — an account listed in
 * `platform_admins` (`server/admin.ts`). Everybody else gets a 404, the same
 * answer the admin API gives a signed-in caller who is not an admin. That
 * hides nothing (the routes are in a public repository); it is simply the
 * answer for something they cannot see. The API is the boundary: a browser
 * that talked itself past this check would draw four tabs of 404s.
 *
 * ── Somebody who stops being an admin while the page is open ──
 * Removing yourself on the Admins tab, or being removed by another admin and
 * then re-reading the session. The page they were using does not turn into a
 * 404 under them — that is the answer for a stranger — but says what happened
 * and where to go. Only a page that has never been an admin's is the 404.
 *
 * ── What every change here leaves behind ──
 * A line in the affected organisation's own audit log, attributed to "xecret
 * support" with the admin's reason, which its owners can read — never the
 * admin's own address, which is the server's log line's to keep. The page says
 * so up front, and the grant dialogs ask for the reason that goes with it.
 */

/** What the page draws: the tabs, the notice for an admin who just stopped being one, or a 404. */
export function adminPageState(admin: boolean, wasAdmin: boolean): 'admin' | 'left' | 'not-found' {
  if (admin) return 'admin';
  return wasAdmin ? 'left' : 'not-found';
}

export function AdminScreen() {
  const { admin } = useSession();
  // Whether this page has been an admin's since it mounted. Adjusted during
  // render, React's documented way to follow a prop, so the session flipping
  // to `admin: true` is remembered on the same render that shows it.
  const [wasAdmin, setWasAdmin] = useState(admin);
  if (admin && !wasAdmin) setWasAdmin(true);

  const state = adminPageState(admin, wasAdmin);
  // Thrown during render, so the nearest not-found boundary draws the page an
  // unknown address would have — before any request is made.
  if (state === 'not-found') notFound();
  if (state === 'left') return <NoLongerAdmin />;
  return <AdminTabs />;
}

function NoLongerAdmin() {
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <EmptyState
        icon={<ShieldIcon />}
        title="You are no longer an admin"
        description="This account was taken off xecret’s admins, so this page is closed to it. Only an admin can add it again."
        action={
          <Button variant="primary" asChild>
            <Link href={appPath.root()}>Go to your organisations</Link>
          </Button>
        }
      />
    </div>
  );
}

function AdminTabs() {
  // Held here rather than in the tab, so looking at the grants and coming back
  // finds the search where it was left. The tab's request is made again on
  // the way back, which is the point: the grants tab may have just changed it.
  const [query, setQuery] = useState<string | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Admin"
        badge={<Badge tone="warning">xecret staff only</Badge>}
        description="Free plans, promo codes, and who the admins are. Every change to an organisation made here goes in the affected organisation’s audit log as xecret support, with the reason you give, where its owners can read it. Your own address is not shown to them."
      />

      <Tabs defaultValue="organizations">
        <TabsList aria-label="Admin">
          <TabsTrigger value="organizations">Organisations</TabsTrigger>
          <TabsTrigger value="grants">Grants</TabsTrigger>
          <TabsTrigger value="promo-codes">Promo codes</TabsTrigger>
          <TabsTrigger value="admins">Admins</TabsTrigger>
        </TabsList>
        <TabsContent value="organizations">
          <OrganizationsTab query={query} onSearch={setQuery} />
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
