'use client';

import { Skeleton } from '@/components/ui';
import type { AdminOverviewPayload } from '@/server/schemas/admin';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { StatCard } from './admin-lists';
import { ErrorState } from './resource-states';

/**
 * The Overview tab: how big the service is — accounts, organisations,
 * projects, environments and secrets — and how many people signed up lately.
 *
 * Live rows only, and each counted inside live parents: a secret in a deleted
 * project is not one any more. Counts are all this tab can say about what is
 * inside an organisation; what a customer calls their projects and secrets is
 * theirs, and the server never sends it.
 *
 * Read once when the tab is opened, and again only when somebody comes back to
 * it — never on a timer.
 */
export function OverviewTab() {
  const overview = useApiResource<AdminOverviewPayload>(apiPath.adminOverview());
  const data = overview.data;

  if (overview.error !== null) {
    return (
      <ErrorState
        subject="the totals"
        error={overview.error}
        onRetry={() => void overview.reload()}
      />
    );
  }
  if (data === null) {
    return (
      <div aria-busy="true" aria-label="Counting" className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="admin-totals" className="flex flex-col gap-3">
        <h2 id="admin-totals" className="text-fg text-sm font-semibold">
          In use now
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Users" value={data.totals.users} />
          <StatCard label="Organisations" value={data.totals.organizations} />
          <StatCard label="Projects" value={data.totals.projects} />
          <StatCard label="Environments" value={data.totals.environments} />
          <StatCard label="Secrets" value={data.totals.secrets} />
        </div>
      </section>

      <section aria-labelledby="admin-signups" className="flex flex-col gap-3">
        <h2 id="admin-signups" className="text-fg text-sm font-semibold">
          Sign-ups
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Last 7 days" value={data.signups.last7Days} hint="New accounts" />
          <StatCard label="Last 30 days" value={data.signups.last30Days} hint="New accounts" />
        </div>
      </section>

      <p className="text-fg-subtle max-w-2xl text-sm leading-6">
        Deleted accounts, organisations, projects, environments and secrets are not counted, nor
        anything inside a deleted one. These are counts and nothing more: what a customer calls
        their projects, environments and secrets is theirs, and is never sent to this page.
      </p>
    </div>
  );
}
