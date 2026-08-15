'use client';

import { Fragment, useMemo, useState } from 'react';

import { canAssignRole } from '@xecret/core/authz';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { pluralize } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Badge,
  Button,
  ChevronRightIcon,
  ChevronUpDownIcon,
  EmptyState,
  Input,
  PlusIcon,
  SearchIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { MemberAccessPanel } from '@/components/members/member-access-panel';
import { MemberRowActions } from '@/components/members/member-actions';
import { ROLE_LABELS, ROLE_TONE, ROLES_DESCENDING } from '@/components/members/types';
import type { InvitationListResponse, MemberListResponse } from '@/components/members/types';
import type { ProjectListResponse } from '@/components/projects/types';
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
 * **Access grants are not a column here.** "Who may read production" is a
 * different and far more sensitive question than "who is in this organisation";
 * it opens per member from the row's key icon, as a dialog holding the
 * effective-permission preview beside the controls that change it.
 *
 * ── Controls follow authority ──
 * The role select and the actions menu render only where the viewer's role
 * could complete the action — at least `admin`, not their own row, and never a
 * member whose role is above theirs. The server re-checks everything,
 * including the last-owner invariant that only the database can answer.
 */

type SortKey = 'name' | 'role' | 'joined';
type SortDirection = 'asc' | 'desc';

const ALL_PROJECTS = 'all';

export function MembersScreen({ orgSlug }: { orgSlug: string }) {
  const organization = useOrganization(orgSlug);
  const viewerRole = organization?.role ?? null;
  const canManage = viewerRole !== null && isOrgAdmin(viewerRole);

  const members = useApiResource<MemberListResponse>(apiPath.members(orgSlug));
  // Invitations are fetched only for people who could see them; asking and
  // rendering the 403 would turn a permission into an error state. The project
  // list feeds the project filter, which exists only for the same people —
  // the listing carries per-member project reach only for admins.
  const invitations = useApiResource<InvitationListResponse>(
    canManage ? apiPath.invitations(orgSlug) : null,
  );
  const projects = useApiResource<ProjectListResponse>(
    canManage ? apiPath.projects(orgSlug) : null,
  );

  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [inviting, setInviting] = useState(false);
  // Which members' access accordions are open. A set, not a single id: two
  // members' access side by side is exactly how "why can she and not he" gets
  // answered, so opening one never folds another.
  const [expandedMembers, setExpandedMembers] = useState<ReadonlySet<string>>(new Set());

  function toggleMember(memberId: string) {
    setExpandedMembers((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  const visible = useMemo(() => {
    const rows = members.data?.data ?? [];
    const needle = query.trim().toLowerCase();

    const filtered = rows.filter((member) => {
      if (
        needle.length > 0 &&
        !member.email.toLowerCase().includes(needle) &&
        !(member.displayName ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      // `projects` is present only for admin viewers — exactly the people the
      // filter control is drawn for, so a missing field never hides a row.
      if (projectFilter !== ALL_PROJECTS && member.projects !== undefined) {
        return member.projects.includes(projectFilter);
      }
      return true;
    });

    filtered.sort((a, b) => {
      const order =
        sortKey === 'name'
          ? (a.displayName ?? a.email)
              .toLowerCase()
              .localeCompare((b.displayName ?? b.email).toLowerCase())
          : sortKey === 'role'
            ? ROLES_DESCENDING.indexOf(a.role) - ROLES_DESCENDING.indexOf(b.role)
            : a.joinedAt.localeCompare(b.joinedAt);
      return sortDirection === 'asc' ? order : -order;
    });

    return filtered;
  }, [members.data, query, projectFilter, sortKey, sortDirection]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    // Names read best A→Z, roles highest-first, join dates newest-first.
    setSortDirection(key === 'joined' ? 'desc' : 'asc');
  }

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

            {canManage && (projects.data?.projects.length ?? 0) > 0 ? (
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="w-48" aria-label="Filter members by project access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                  {(projects.data?.projects ?? []).map((project) => (
                    <SelectItem key={project.slug} value={project.slug}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {/* The count and the seat state, announced politely. */}
          <p role="status" aria-live="polite" className="text-fg-subtle text-[0.8125rem]">
            {query.trim().length === 0 && projectFilter === ALL_PROJECTS
              ? pluralize(members.data.data.length, 'member')
              : `${visible.length} of ${pluralize(members.data.data.length, 'member')} shown`}
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
              title={
                query.trim().length > 0
                  ? `Nothing matches “${query.trim()}”`
                  : 'Nobody can reach this project'
              }
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('');
                    setProjectFilter(ALL_PROJECTS);
                  }}
                >
                  Clear the filters
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
                    <SortableHead
                      label="Member"
                      active={sortKey === 'name'}
                      direction={sortDirection}
                      onSort={() => toggleSort('name')}
                    />
                    <SortableHead
                      label="Role"
                      className="w-32"
                      active={sortKey === 'role'}
                      direction={sortDirection}
                      onSort={() => toggleSort('role')}
                    />
                    <TableHead className="w-28">Status</TableHead>
                    <SortableHead
                      label="Joined"
                      className="w-32"
                      active={sortKey === 'joined'}
                      direction={sortDirection}
                      onSort={() => toggleSort('joined')}
                    />
                    <TableHead className="w-96">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((member) => {
                    // Only rows whose access the server would show this viewer
                    // are expandable: admins see anyone, everyone sees their
                    // own. An unexpandable row is a plain row, not a broken
                    // accordion.
                    const expandable = canManage || member.isYou;
                    const isExpanded = expandable && expandedMembers.has(member.id);

                    return (
                      <Fragment key={member.id}>
                        <TableRow
                          className={cn(expandable && 'cursor-pointer')}
                          {...(expandable ? { onClick: () => toggleMember(member.id) } : {})}
                        >
                          <TableCell>
                            {/* A real button around the identity, so the
                                accordion opens from the keyboard too — the row
                                onClick is the pointer convenience, this is the
                                accessible control. */}
                            <button
                              type="button"
                              disabled={!expandable}
                              aria-expanded={expandable ? isExpanded : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleMember(member.id);
                              }}
                              className="flex min-w-0 items-center gap-2 text-left"
                            >
                              {expandable ? (
                                <ChevronRightIcon
                                  aria-hidden="true"
                                  className={cn(
                                    'text-fg-subtle size-4 shrink-0 transition-transform',
                                    isExpanded && 'rotate-90',
                                  )}
                                />
                              ) : (
                                <span aria-hidden="true" className="size-4 shrink-0" />
                              )}
                              <span
                                aria-hidden="true"
                                className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold"
                              >
                                {initials(member.displayName ?? member.email)}
                              </span>
                              <span className="min-w-0">
                                <span className="text-fg block truncate text-[0.8125rem] font-medium">
                                  {member.displayName ?? member.email}
                                  {member.isYou ? (
                                    <span className="text-fg-subtle font-normal"> · you</span>
                                  ) : null}
                                </span>
                                {member.displayName !== null ? (
                                  <span className="text-fg-subtle block truncate text-xs">
                                    {member.email}
                                  </span>
                                ) : null}
                              </span>
                            </button>
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

                          {/* Clicks on the row's controls are theirs alone —
                              changing a role must not also fold the accordion. */}
                          <TableCell onClick={(event) => event.stopPropagation()}>
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

                        {isExpanded ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={5} className="bg-canvas-inset/40 p-0">
                              <MemberAccessPanel
                                orgSlug={orgSlug}
                                member={member}
                                mayEdit={
                                  viewerRole !== null &&
                                  canManage &&
                                  !member.isYou &&
                                  canAssignRole(viewerRole, member.role)
                                }
                                onCollapse={() => toggleMember(member.id)}
                                onChanged={members.reload}
                              />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
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

function SortableHead({
  label,
  active,
  direction,
  onSort,
  className,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  className?: string;
}) {
  return (
    // `aria-sort` belongs on the header cell, not on the button inside it, and
    // exactly one column may carry a value other than "none".
    <TableHead
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      {...(className === undefined ? {} : { className })}
    >
      <button
        type="button"
        onClick={onSort}
        className="hover:text-fg -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors"
      >
        {label}
        <ChevronUpDownIcon
          aria-hidden="true"
          className={cn('size-3.5', active ? 'text-accent-text' : 'text-fg-subtle')}
        />
      </button>
    </TableHead>
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
