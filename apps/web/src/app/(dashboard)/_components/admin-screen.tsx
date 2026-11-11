'use client';

import { notFound } from 'next/navigation';
import { useState } from 'react';

import { PageHeader } from '@/components/layout';
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { GrantsTab } from './admin-grants';
import { OrganizationsTab } from './admin-organizations';
import { PromoCodesTab } from './admin-promo-codes';
import { useSession } from './session';

/**
 * The admin page (`/app/admin`): where xecret's own staff give an organisation
 * a free plan, keep an eye on the ones given, and issue promo codes.
 *
 * ── Who sees it ──
 * Whoever `/api/auth/me` says is on the admin allow-list (`server/admin.ts`).
 * Everybody else gets the 404 any unknown address gets — not a "you may not",
 * which would confirm there is something here to be refused. That is the same
 * answer the admin API gives them, and it is the API that is the boundary: a
 * browser that talked itself past this check would draw three tabs of 404s.
 *
 * ── What every change here leaves behind ──
 * A line in the affected organisation's own audit log, attributed to "xecret
 * support" with the admin's reason, which its owners can read — never the
 * admin's own address, which is the server's log line's to keep. The page says
 * so up front, and the grant dialogs ask for the reason that goes with it.
 */
export function AdminScreen() {
  const { admin } = useSession();
  // Thrown during render, so the nearest not-found boundary draws the page an
  // unknown address would have — before any request is made.
  if (!admin) notFound();
  return <AdminTabs />;
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
        description="Free plans and promo codes. Every change made here goes in the affected organisation’s audit log as xecret support, with the reason you give, where its owners can read it. Your own address is not shown to them."
      />

      <Tabs defaultValue="organizations">
        <TabsList aria-label="Admin">
          <TabsTrigger value="organizations">Organisations</TabsTrigger>
          <TabsTrigger value="grants">Grants</TabsTrigger>
          <TabsTrigger value="promo-codes">Promo codes</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
