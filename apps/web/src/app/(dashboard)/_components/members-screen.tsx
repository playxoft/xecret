'use client';

import { useMemo, useState } from 'react';

import { initials } from '@/lib/format';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { pluralize } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PlusIcon,
  SearchIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  UsersIcon,
} from '@/components/ui';
import { InvitationsSection } from '@/components/members/invitations-section';
import { InviteDialog } from '@/components/members/invite-dialog';
import { MemberRowActions } from '@/components/members/member-actions';
import { ROLE_LABELS, ROLE_TONE } from '@/components/members/types';
import type { InvitationListResponse, MemberListResponse } from '@/components/members/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

/**
 * Who is in this organisation — and, for admins, the controls that change it.
 *
 * ── What is here, and what is deliberately not ──
 * Names, emails, roles, status, join dates, the seat count, and — for people
 * holding `member.invite` — the open invitations. Emails are shown to every
 * member on purpose: they are how people are invited and how they appear in
 * the audit log.
 *
 * **Access grants are not here.** "Who may read production" is a different and
 * far more sensitive question than "who is in this organisation"; it lives on
 * each member's own page (`/members/{id}`), with the effective-permission
 * preview beside the controls that change it.
 *
 * ── Controls follow authority ──
 * The role select and the actions menu render only where the viewer's role
 * could complete the action — at least `admin`, not their own row, and never a
 * member whose role is above theirs. The server re-checks everything,
 * including the last-owner invariant that only the database can answer.
 */

export function MembersScreen({ orgSlug }: { orgSlug: string }) {
  const organization = useOrganization(orgSlug);
  const viewerRole = organization?.role ?? null;
  const canManage = viewerRole !== null && isOrgAdmin(viewerRole);

  const members = useApiResource<MemberListResponse>(apiPath.members(orgSlug));
  // Invitations are fetched only for people who could see them; asking and
  // rendering the 403 would turn a permission into an error state.
  const invitations = useApiResource<InvitationListResponse>(
    canManage ? apiPath.invitations(orgSlug) : null,
  );

  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);

  const visible = useMemo(() => {
    const rows = members.data?.data ?? [];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return rows;

    return rows.filter(
      (member) =>
        member.email.toLowerCase().includes(needle) ||
        (member.displayName ?? '').toLowerCase().includes(needle),
    );
  }, [members.data, query]);

  const seats = members.data?.seats;

  function reloadAll() {
    members.reload();
    invitations.reload();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Members"
        description="Everyone who can act in this organisation. Access to individual projects and environments is granted per member."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <PlusIcon className="size-4" /> Invite
            </Button>
          ) : undefined
        }
      />

      {members.error !== null ? (
        <ErrorState subject="the member list" error={members.error} onRetry={members.reload} />
      ) : members.data === null ? (
        <MembersSkeleton />
      ) : (
        <>
          {canManage && invitations.data !== null ? (
            <InvitationsSection
              orgSlug={orgSlug}
              invitations={invitations.data.data}
              onChanged={reloadAll}
              onReinvite={() => setInviting(true)}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 sm:max-w-xs">
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name or email"
                aria-label="Filter members"
                autoComplete="off"
                startIcon={<SearchIcon className="size-4" />}
              />
            </div>
          </div>

          {/* The count and the seat state, announced politely. */}
          <p role="status" aria-live="polite" className="text-fg-subtle text-[0.8125rem]">
            {query.trim().length === 0
              ? pluralize(members.data.data.length, 'member')
              : `${visible.length} of ${pluralize(members.data.data.length, 'member')} match “${query.trim()}”`}
            {seats !== undefined ? (
              <>
                {' · '}
                {seats.used + seats.pendingInvitations} of {seats.limit} seats used
                {seats.pendingInvitations > 0
                  ? ` (${pluralize(seats.pendingInvitations, 'pending invitation')})`
                  : ''}
              </>
            ) : null}
          </p>

          {visible.length === 0 && members.data.data.length > 0 ? (
            <EmptyState
              icon={<SearchIcon />}
              title={`Nothing matches “${query.trim()}”`}
              action={
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear the filter
                </Button>
              }
            />
          ) : members.data.data.length === 0 ? (
            <EmptyState
              icon={<UsersIcon />}
              title="You are the only member"
              description="Invite someone and they will appear here with the role you give them."
              action={
                canManage ? (
                  <Button variant="primary" onClick={() => setInviting(true)}>
                    Invite a member
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer aria-label={`Members of ${orgSlug}`}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead className="w-32">Role</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead className="w-32">Joined</TableHead>
                    <TableHead className="w-52">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold"
                          >
                            {initials(member.displayName ?? member.email)}
                          </span>
                          <div className="min-w-0">
                            <p className="text-fg truncate text-[0.8125rem] font-medium">
                              {member.displayName ?? member.email}
                              {member.isYou ? (
                                <span className="text-fg-subtle font-normal"> · you</span>
                              ) : null}
                            </p>
                            {member.displayName !== null ? (
                              <p className="text-fg-subtle truncate text-xs">{member.email}</p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>

                      <TableCell>
                        <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>
                          {ROLE_LABELS[member.role]}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        {member.status === 'active' ? (
                          <span className="text-fg-muted text-[0.8125rem]">Active</span>
                        ) : (
                          <Badge tone="warning">Suspended</Badge>
                        )}
                      </TableCell>

                      <TableCell className="text-fg-muted text-[0.8125rem] whitespace-nowrap">
                        <time
                          dateTime={toIsoString(member.joinedAt)}
                          title={formatAbsoluteTime(member.joinedAt)}
                        >
                          {formatRelativeTime(member.joinedAt)}
                        </time>
                      </TableCell>

                      <TableCell>
                        {viewerRole !== null && canManage ? (
                          <MemberRowActions
                            orgSlug={orgSlug}
                            member={member}
                            viewerRole={viewerRole}
                            onChanged={reloadAll}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}

      {viewerRole !== null ? (
        <InviteDialog
          orgSlug={orgSlug}
          viewerRole={viewerRole}
          open={inviting}
          onOpenChange={setInviting}
          onInvited={reloadAll}
        />
      ) : null}
    </div>
  );
}

function MembersSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading members" className="flex flex-col gap-4">
      <Skeleton className="h-9 w-full sm:max-w-xs" />
      <div className="border-line bg-surface rounded-xl border">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="border-line-subtle flex items-center gap-4 px-3 py-3.5 last:border-b-0 [&:not(:last-child)]:border-b"
          >
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
