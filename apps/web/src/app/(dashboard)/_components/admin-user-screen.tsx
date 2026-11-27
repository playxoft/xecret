'use client';

import Link from 'next/link';

import { isApiError } from '@/lib/api';
import { PageHeader } from '@/components/layout';
import {
  Badge,
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
import type { AdminAccountDetailPayload } from '@/server/schemas/admin';
import { apiPath, appPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { AdminGate } from './admin-gate';
import {
  BackLink,
  count,
  Moment,
  roleLabel,
  signInMethodLabel,
  VerifiedBadge,
} from './admin-lists';
import { ErrorState } from './resource-states';

/**
 * One account, on the admin page (`/app/admin/users/{id}`): who it is, when it
 * signed up and last signed in and how, and the organisations it is in — each
 * opening that organisation's own page.
 *
 * The account data xecret keeps as its controller, and nothing more: no
 * address a session came from, no browser or device, no avatar. Looking is not
 * written to any organisation's audit log.
 */
export function AdminUserScreen({ userId }: { userId: string }) {
  return (
    <AdminGate>
      <UserDetail userId={userId} />
    </AdminGate>
  );
}

const BACK = { href: appPath.adminTab('users'), label: 'All users' };

function UserDetail({ userId }: { userId: string }) {
  const detail = useApiResource<AdminAccountDetailPayload>(apiPath.adminUser(userId));

  if (detail.error !== null) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <BackLink href={BACK.href}>{BACK.label}</BackLink>
        {isApiError(detail.error) && detail.error.code === 'not_found' ? (
          <EmptyState
            icon={<SearchIcon />}
            title="No such account"
            description="It may have been deleted. A deleted account is not shown here at all."
          />
        ) : (
          <ErrorState
            subject="this account"
            error={detail.error}
            onRetry={() => void detail.reload()}
          />
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

  const { user, organizations } = detail.data;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <BackLink href={BACK.href}>{BACK.label}</BackLink>
      <PageHeader
        title={user.email}
        badge={
          <>
            <VerifiedBadge verified={user.emailVerified} />
            <Badge tone="warning">xecret staff only</Badge>
          </>
        }
        description={user.displayName ?? 'No display name'}
      />

      <Card className="p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-fg-muted">Signed up</dt>
            <dd className="mt-1">
              <Moment value={user.signedUpAt} />
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Last sign-in</dt>
            <dd className="mt-1">
              <Moment value={user.lastSignInAt} never="Never" />
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Latest session signed in with</dt>
            <dd className="text-fg mt-1">{signInMethodLabel(user.lastSignInMethod)}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Organisations</dt>
            <dd className="text-fg mt-1 tabular-nums">{count(user.organizationCount)}</dd>
          </div>
        </dl>
      </Card>

      <section aria-labelledby="admin-user-orgs" className="flex flex-col gap-3">
        <h2 id="admin-user-orgs" className="text-fg text-sm font-semibold">
          Organisations
        </h2>
        {organizations.length === 0 ? (
          <p className="text-fg-muted text-sm">Not a member of any organisation.</p>
        ) : (
          <TableContainer aria-label={`Organisations ${user.email} is in`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organisation</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((organization) => (
                  <TableRow key={organization.id}>
                    <TableCell>
                      <Link
                        href={appPath.adminOrganization(organization.id)}
                        className="text-fg decoration-line-strong hover:decoration-fg text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {organization.name}
                      </Link>
                      <p className="text-fg-subtle font-mono text-sm">{organization.slug}</p>
                    </TableCell>
                    <TableCell className="text-sm">{roleLabel(organization.role)}</TableCell>
                    <TableCell className="text-sm">
                      <Moment value={organization.joinedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
    </div>
  );
}
