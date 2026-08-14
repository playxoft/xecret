'use client';

import { useEffect, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FileTextIcon,
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
} from '@/components/ui';
import type { ProjectListResponse } from '@/components/projects/types';
import type { AuditEvent, AuditListResponse } from '@/components/tokens/types';
import { apiPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';

/**
 * The audit log: every mutation, every decryption, every denial.
 *
 * Server-filtered, keyset-paginated — the accumulate-on-load-more shape
 * `useSecretList` uses, because an offset would shift under this table's own
 * write load. Changing any filter starts the accumulation over from the top.
 *
 * The scanned window is printed, not implied: the server clamps queries to
 * ninety days, and a page that silently showed less than it was asked for
 * would be lying about history — the one thing an audit page cannot do.
 */

const OUTCOME_TONE = { success: undefined, denied: 'warning', error: 'danger' } as const;

/** Actions offered as filters. A plain list, not an import: the filter is a
 *  convenience over the stored strings, and an old row's action must remain
 *  filterable even if a later release renames the constant that wrote it. */
const ACTIONS = [
  'secret.read',
  'secret.revealed',
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.imported',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.role_changed',
  'member.suspended',
  'member.reinstated',
  'invitation.revoked',
  'access.granted',
  'access.revoked',
  'access.denied',
  'token.authorized',
  'token.created',
  'token.revoked',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
] as const;

interface Filters {
  action: string;
  outcome: string;
  projectSlug: string;
}

const NO_FILTER = 'all';

export function AuditScreen({ orgSlug }: { orgSlug: string }) {
  const projects = useApiResource<ProjectListResponse>(apiPath.projects(orgSlug));

  const [filters, setFilters] = useState<Filters>({
    action: NO_FILTER,
    outcome: NO_FILTER,
    projectSlug: NO_FILTER,
  });

  // The accumulated result carries the filter key it belongs to, exactly as
  // `useApiResource` carries its path: a slow response for an old filter set
  // renders as absent rather than under the new heading, and no state is ever
  // written synchronously inside the effect.
  interface Accumulated {
    key: string;
    events: readonly AuditEvent[];
    nextCursor: string | null;
    window: { from: string; to: string } | null;
    error: unknown;
  }

  const filterKey = `${orgSlug}|${filters.action}|${filters.outcome}|${filters.projectSlug}`;
  const [state, setState] = useState<Accumulated>({
    key: '',
    events: [],
    nextCursor: null,
    window: null,
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);

  const firstPagePath = withQuery(apiPath.audit(orgSlug), {
    action: filters.action === NO_FILTER ? undefined : filters.action,
    outcome: filters.outcome === NO_FILTER ? undefined : filters.outcome,
    projectSlug: filters.projectSlug === NO_FILTER ? undefined : filters.projectSlug,
  });

  useEffect(() => {
    const controller = new AbortController();

    api
      .get<AuditListResponse>(firstPagePath, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          key: filterKey,
          events: page.data,
          nextCursor: page.nextCursor,
          window: page.window,
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ key: filterKey, events: [], nextCursor: null, window: null, error: cause });
      });

    return () => controller.abort();
  }, [firstPagePath, filterKey]);

  const current = state.key === filterKey ? state : null;
  const events = current?.events ?? [];
  const nextCursor = current?.nextCursor ?? null;
  const window = current?.window ?? null;
  const error = current?.error ?? null;
  const loading = current === null || loadingMore;

  // From an event handler, so the synchronous setState is fine — it is what
  // gives the button a visible loading state.
  function loadMore() {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);

    api
      .get<AuditListResponse>(withQuery(firstPagePath, { cursor: nextCursor }))
      .then((page) => {
        setState((previous) =>
          previous.key === filterKey
            ? {
                ...previous,
                events: [...previous.events, ...page.data],
                nextCursor: page.nextCursor,
                window: page.window,
              }
            : previous,
        );
      })
      .catch((cause: unknown) => {
        setState((previous) =>
          previous.key === filterKey ? { ...previous, error: cause } : previous,
        );
      })
      .finally(() => setLoadingMore(false));
  }

  const forbidden = isApiError(error) && (error.code === 'forbidden' || error.code === 'not_found');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every mutation, every decryption, and every denial — with who, when, from where, and the outcome."
      />

      {forbidden ? (
        <Alert tone="info" title="Owners and admins only">
          The audit log is an organisation-wide record, including activity in projects you cannot
          see. Ask an owner or admin when you need something from it.
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Action"
              value={filters.action}
              onChange={(action) => setFilters((f) => ({ ...f, action }))}
              options={[
                { value: NO_FILTER, label: 'All actions' },
                ...ACTIONS.map((action) => ({ value: action, label: action })),
              ]}
            />
            <FilterSelect
              label="Outcome"
              value={filters.outcome}
              onChange={(outcome) => setFilters((f) => ({ ...f, outcome }))}
              options={[
                { value: NO_FILTER, label: 'All outcomes' },
                { value: 'success', label: 'Success' },
                { value: 'denied', label: 'Denied' },
                { value: 'error', label: 'Error' },
              ]}
            />
            <FilterSelect
              label="Project"
              value={filters.projectSlug}
              onChange={(projectSlug) => setFilters((f) => ({ ...f, projectSlug }))}
              options={[
                { value: NO_FILTER, label: 'All projects' },
                ...(projects.data?.projects ?? []).map((project) => ({
                  value: project.slug,
                  label: project.name,
                })),
              ]}
            />
          </div>

          {window !== null ? (
            <p role="status" className="text-fg-subtle text-[0.8125rem]">
              Showing {formatAbsoluteTime(window.from)} — {formatAbsoluteTime(window.to)}. Queries
              cover at most 90 days at a time.
            </p>
          ) : null}

          {error !== null && !forbidden ? (
            <Alert tone="danger" title="The audit log could not be loaded">
              {errorMessage(error)}
            </Alert>
          ) : null}

          {loading && events.length === 0 ? (
            <div aria-busy="true" aria-label="Loading audit events" className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-11 w-full rounded-lg" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon={<FileTextIcon />}
              title="Nothing in this window"
              description="No events match these filters in the last 90 days."
            />
          ) : (
            <>
              <TableContainer aria-label="Audit events">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead className="w-48">Action</TableHead>
                      <TableHead className="w-24">Outcome</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="text-fg-muted text-[0.8125rem] whitespace-nowrap">
                          <time
                            dateTime={toIsoString(event.createdAt)}
                            title={formatAbsoluteTime(event.createdAt)}
                          >
                            {formatRelativeTime(event.createdAt)}
                          </time>
                        </TableCell>
                        <TableCell>
                          <p className="text-fg truncate text-[0.8125rem]">
                            {event.actorLabel ?? '—'}
                          </p>
                          {event.ipAddress !== null ? (
                            <p className="text-fg-subtle font-mono text-xs">{event.ipAddress}</p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <code className="text-fg-muted font-mono text-xs">{event.action}</code>
                        </TableCell>
                        <TableCell>
                          {event.outcome === 'success' ? (
                            <span className="text-fg-muted text-[0.8125rem]">ok</span>
                          ) : (
                            <Badge tone={OUTCOME_TONE[event.outcome] ?? 'neutral'}>
                              {event.outcome}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-fg-muted max-w-64 truncate text-[0.8125rem]">
                          {describeEvent(event)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {nextCursor !== null ? (
                <div>
                  <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-44" aria-label={`Filter by ${label.toLowerCase()}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * One line of context from the metadata the builder recorded. Values here were
 * sanitised and redacted at write time; this only chooses which to surface.
 */
function describeEvent(event: AuditEvent): string {
  const m = event.metadata;
  const parts: string[] = [];

  if (typeof m['secretName'] === 'string') parts.push(m['secretName']);
  if (typeof m['secretCount'] === 'number') parts.push(`${m['secretCount']} secrets`);
  if (typeof m['targetEmail'] === 'string') parts.push(m['targetEmail']);
  if (typeof m['previousRole'] === 'string' && typeof m['newRole'] === 'string') {
    parts.push(`${m['previousRole']} → ${m['newRole']}`);
  } else if (typeof m['newRole'] === 'string') {
    parts.push(`as ${m['newRole']}`);
  }
  if (typeof m['newAccessLevel'] === 'string') {
    parts.push(
      typeof m['previousAccessLevel'] === 'string'
        ? `${m['previousAccessLevel']} → ${m['newAccessLevel']}`
        : m['newAccessLevel'],
    );
  }
  if (typeof m['projectSlug'] === 'string') {
    parts.push(
      typeof m['environmentSlug'] === 'string'
        ? `${m['projectSlug']}/${m['environmentSlug']}`
        : m['projectSlug'],
    );
  }
  if (typeof m['deviceName'] === 'string') parts.push(m['deviceName']);
  if (typeof m['reason'] === 'string' && event.outcome !== 'success') parts.push(m['reason']);

  return parts.join(' · ');
}
