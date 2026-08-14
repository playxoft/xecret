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
import type { BadgeTone } from '@/components/ui';
import type { OrgRole } from '@xecret/core/authz';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';

/**
 * Who is in this organisation.
 *
 * ── What is here, and what is deliberately not ──
 * Names, emails, roles, and when each person joined. Emails are shown to every
 * member on purpose: they are how people are invited and how they appear in the
 * audit log, so hiding them would hide nothing while making the list useless for
 * the thing it is for — working out who to ask about a credential.
 *
 * **Access grants are not here.** "Who may read production" is a different and
 * far more sensitive question than "who is in this organisation", it is answered
 * per project, and putting it in a list would mean a query per row. It belongs
 * on a member's own page, which does not exist yet.
 *
 * ── Roles are shown, not editable ──
 * There is no role dropdown, because there is no `PATCH …/members/{id}` behind
 * it yet. A control that renders and then fails is worse than one that is
 * absent: the second is a missing feature, the first is a bug report.
 */

interface Member {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  status: 'active' | 'invited' | 'suspended';
  joinedAt: string;
  isYou: boolean;
}

interface MemberListResponse {
  data: readonly Member[];
  nextCursor: string | null;
}

const ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
};

/**
 * Only `owner` gets a tone.
 *
 * Colour in this design system is reserved for things that change what an action
 * costs, and there is exactly one of those in a member list: the person who
 * cannot be removed without stranding the organisation. Colouring all four roles
 * would make a four-colour legend out of a column people scan.
 */
const ROLE_TONE: Readonly<Partial<Record<OrgRole, BadgeTone>>> = {
  owner: 'accent',
};

export function MembersScreen({ orgSlug }: { orgSlug: string }) {
  const members = useApiResource<MemberListResponse>(apiPath.members(orgSlug));
  const [query, setQuery] = useState('');

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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Members"
        description="Everyone who can act in this organisation. Access to individual projects and environments is granted separately."
      />

      {members.error !== null ? (
        <ErrorState subject="the member list" error={members.error} onRetry={members.reload} />
      ) : members.data === null ? (
        <MembersSkeleton />
      ) : members.data.data.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title="You are the only member"
          description="Invite someone and they will appear here with the role you give them."
        />
      ) : (
        <>
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

          {/* The count, announced politely — a filter that silently changes the
              number of rows tells a screen reader user nothing. */}
          <p role="status" aria-live="polite" className="text-fg-subtle text-[0.8125rem]">
            {query.trim().length === 0
              ? pluralize(members.data.data.length, 'member')
              : `${visible.length} of ${pluralize(members.data.data.length, 'member')} match “${query.trim()}”`}
          </p>

          {visible.length === 0 ? (
            <EmptyState
              icon={<SearchIcon />}
              title={`Nothing matches “${query.trim()}”`}
              action={
                <Button variant="secondary" onClick={() => setQuery('')}>
                  Clear the filter
                </Button>
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
                          // Suspended and invited both mean "cannot act right
                          // now", which is the fact worth making visible.
                          <Badge tone={member.status === 'suspended' ? 'warning' : 'neutral'}>
                            {member.status === 'suspended' ? 'Suspended' : 'Invited'}
                          </Badge>
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
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
