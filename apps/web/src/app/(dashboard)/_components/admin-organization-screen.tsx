'use client';

import Link from 'next/link';

import { isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SearchIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import type { AdminOrganizationDetailPayload } from '@/server/schemas/admin';
import { apiPath, appPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { AdminGate } from './admin-gate';
import {
  EndGrantDialog,
  GrantDialog,
  grantSummary,
  grantTargetOf,
  useDialogTarget,
} from './admin-grant-dialogs';
import type { GrantTarget } from './admin-grant-dialogs';
import {
  BackLink,
  count,
  Moment,
  ownersText,
  PlanBadge,
  roleLabel,
  StatCard,
  statusOf,
} from './admin-lists';
import { ErrorState } from './resource-states';

/**
 * One organisation, on the admin page (`/app/admin/organizations/{id}`): what
 * it is on and how that came to be, how much is in it, and who its members
 * are — each opening that account's own page — with the free plan given or
 * ended from here as from a search result.
 *
 * What is inside it is counted, never named: the projects, environments and
 * secrets are the customer's, and the server sends this page how many there
 * are and nothing else. Members are their address, name, role and when they
 * joined — the account data xecret keeps for them.
 *
 * Looking is not written to the organisation's audit log; a free plan given or
 * ended from here is, as xecret support, with the reason asked for.
 */
export function AdminOrganizationScreen({ orgId }: { orgId: string }) {
  return (
    <AdminGate>
      <OrganizationDetail orgId={orgId} />
    </AdminGate>
  );
}

const BACK = { href: appPath.adminTab('organizations'), label: 'All organisations' };

function OrganizationDetail({ orgId }: { orgId: string }) {
  const detail = useApiResource<AdminOrganizationDetailPayload>(apiPath.adminOrganization(orgId));
  const granting = useDialogTarget<GrantTarget>();
  const ending = useDialogTarget<GrantTarget>();
  const reload = () => void detail.reload();

  if (detail.error !== null) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <BackLink href={BACK.href}>{BACK.label}</BackLink>
        {isApiError(detail.error) && detail.error.code === 'not_found' ? (
          <EmptyState
            icon={<SearchIcon />}
            title="No such organisation"
            description="It may have been deleted. A deleted organisation is not shown here at all."
          />
        ) : (
          <ErrorState subject="this organisation" error={detail.error} onRetry={reload} />
        )}
      </div>
    );
  }
  if (detail.data === null) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading"
        className="mx-auto flex w-full max-w-5xl flex-col gap-4"
      >
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  const { organization, members } = detail.data;
  const status = statusOf(organization);
  const granted = organization.grant !== null;
  const target = grantTargetOf(organization);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <BackLink href={BACK.href}>{BACK.label}</BackLink>
      <PageHeader
        title={organization.name}
        badge={
          <>
            <PlanBadge organization={organization} />
            <Badge tone="warning">xecret staff only</Badge>
          </>
        }
        description={
          <>
            <code className="font-mono break-all">{organization.id}</code> · created{' '}
            {formatAbsoluteTime(organization.createdAt)} · owned by{' '}
            {ownersText(organization.ownerEmails)}
          </>
        }
      />

      <section aria-labelledby="admin-org-counts" className="flex flex-col gap-3">
        <h2 id="admin-org-counts" className="text-fg text-sm font-semibold">
          What is in it
        </h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Members" value={organization.counts.members} />
          <StatCard label="Pending invitations" value={organization.counts.pendingInvitations} />
          <StatCard label="Projects" value={organization.counts.projects} />
          <StatCard label="Environments" value={organization.counts.environments} />
          <StatCard label="Secrets" value={organization.counts.secrets} />
        </div>
        <p className="text-fg-subtle text-sm">
          Counts only. What its projects, environments and secrets are called is the customer’s, and
          is never sent to this page.
        </p>
      </section>

      <section aria-labelledby="admin-org-plan" className="flex flex-col gap-3">
        <h2 id="admin-org-plan" className="text-fg text-sm font-semibold">
          Plan
        </h2>
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg">{grantSummary(organization.plan, organization.grant)}</span>
              {status !== null ? <Badge tone={status.tone}>{status.label}</Badge> : null}
              {organization.billedByDodo ? (
                <Badge tone="accent">
                  Paid at checkout
                  {organization.interval !== null ? ` · ${organization.interval}` : ''}
                </Badge>
              ) : null}
              {organization.awaitingActivation ? (
                <Badge tone="warning">A paid checkout is waiting to activate</Badge>
              ) : null}
              {organization.managedBy === 'support' && !granted ? (
                <Badge tone="neutral">Arranged by support</Badge>
              ) : null}
            </div>
            <p className="text-fg-subtle text-sm">
              Up to {count(organization.seats.limit)} members
              {organization.billedByDodo
                ? ` · ${count(organization.seats.billed)} seats billed`
                : ''}
            </p>
            {organization.grant?.note ? (
              <p className="text-fg-muted text-sm">{organization.grant.note}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant={granted ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => granting.show(target)}
            >
              {granted ? 'Change the free plan' : 'Give a free plan'}
            </Button>
            {granted ? (
              <Button
                variant="danger-outline"
                size="sm"
                aria-label={`End ${organization.name}’s free plan`}
                onClick={() => ending.show(target)}
              >
                End it
              </Button>
            ) : null}
          </div>
        </Card>
      </section>

      <section aria-labelledby="admin-org-members" className="flex flex-col gap-3">
        <h2 id="admin-org-members" className="text-fg text-sm font-semibold">
          Members
        </h2>
        {members.length === 0 ? (
          <p className="text-fg-muted text-sm">Nobody. Every member’s account has been deleted.</p>
        ) : (
          <TableContainer aria-label={`Members of ${organization.name}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <Link
                        href={appPath.adminUser(member.userId)}
                        className="text-fg decoration-line-strong hover:decoration-fg text-sm font-medium break-all underline-offset-4 hover:underline"
                      >
                        {member.email}
                      </Link>
                    </TableCell>
                    <TableCell className="text-fg-muted text-sm">
                      {member.displayName ?? 'No name'}
                    </TableCell>
                    <TableCell className="text-sm">{roleLabel(member.role)}</TableCell>
                    <TableCell className="text-sm">
                      <Moment value={member.joinedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {members.length < organization.counts.members ? (
          <p className="text-fg-subtle text-sm">
            The first {count(members.length)} of {count(organization.counts.members)}, the
            longest-standing first.
          </p>
        ) : null}
      </section>

      <GrantDialog
        target={granting.target}
        open={granting.open}
        onOpenChange={granting.onOpenChange}
        onGranted={reload}
      />
      <EndGrantDialog
        target={ending.target}
        open={ending.open}
        onOpenChange={ending.onOpenChange}
        onEnded={reload}
      />
    </div>
  );
}
