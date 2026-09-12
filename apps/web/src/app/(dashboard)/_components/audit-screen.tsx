'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  Badge,
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
import type { Member, MemberListResponse } from '@/components/members/types';
import type { ProjectListResponse } from '@/components/projects/types';
import type { AuditEvent, AuditListResponse } from '@/components/tokens/types';
import { apiPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { infiniteScrollSupported, useInfiniteScroll } from '../_lib/use-infinite-scroll';

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
  'auth.autolock_changed',
] as const;

interface Filters {
  action: string;
  outcome: string;
  projectSlug: string;
  /**
   * User ids, in selection order. Several, because the question this page gets
   * asked is "what did these two people do", and a single-value filter turns
   * that into two passes the reader has to interleave by eye.
   *
   * Ids rather than the email addresses they are chosen by: an address is what
   * a person recognises, and `actorId` is what the row was written with. A
   * member who changes their address keeps their history either way.
   */
  actorIds: readonly string[];
}

const NO_FILTER = 'all';

/** What the member listing clamps a page to, so three requests is 600 people. */
const ACTOR_PAGE_SIZE = 200;

/**
 * How far the actor picker will page before it stops and says so.
 *
 * The listing is paginated and this used to read exactly one page of it, which
 * meant an organisation past that boundary had colleagues who simply could not
 * be filtered on — with nothing on screen to say a name was missing rather than
 * absent from the log. Three pages covers every organisation this product has,
 * and the menu admits the horizon on the one that does not, because an audit
 * screen that quietly narrows what you can ask about is the wrong kind of quiet.
 */
const ACTOR_MAX_PAGES = 3;

export function AuditScreen({ orgSlug }: { orgSlug: string }) {
  const projects = useApiResource<ProjectListResponse>(apiPath.projects(orgSlug));

  const members = useFilterableMembers(orgSlug);

  const [filters, setFilters] = useState<Filters>({
    action: NO_FILTER,
    outcome: NO_FILTER,
    projectSlug: NO_FILTER,
    actorIds: [],
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

  // The actor ids are sorted into the key, not appended in click order: picking
  // two people in the other order is the same query, and re-fetching for it
  // would throw away a log somebody had already scrolled a long way down.
  const filterKey = [
    orgSlug,
    filters.action,
    filters.outcome,
    filters.projectSlug,
    [...filters.actorIds].sort().join(','),
  ].join('|');
  const [state, setState] = useState<Accumulated>({
    key: '',
    events: [],
    nextCursor: null,
    window: null,
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * Why the last "next page" failed, and which filter set it belongs to.
   *
   * Tagged with the key for the same reason the accumulated page is: changing a
   * filter starts a new query, and a failure from the old one must not block
   * the new one's sentinel or print a message about a request nobody made.
   *
   * Held apart from `state.error` on purpose. That one replaces the table with
   * an alert, which is right for a first page that would not load and wrong for
   * a second one: the rows already read are still good, still on screen, and the
   * only thing that failed is the offer of more.
   */
  const [pagingError, setPagingError] = useState<{ key: string; cause: unknown } | null>(null);

  // Every filter this query carries, in one object, built once. The paged
  // request is the same object plus a cursor — one `withQuery` call rather than
  // a second one wrapped around the first, which appended a second `?` and sent
  // `…?action=secret.read?cursor=…` for every filtered page.
  const queryParams = useMemo(
    () => ({
      action: filters.action === NO_FILTER ? undefined : filters.action,
      outcome: filters.outcome === NO_FILTER ? undefined : filters.outcome,
      projectSlug: filters.projectSlug === NO_FILTER ? undefined : filters.projectSlug,
      // Sorted for the same reason the key is, so the two agree on what one
      // query is. `undefined` when nothing is selected: an empty `actorIds=`
      // would be a filter that matches nobody if the server ever stopped
      // ignoring it.
      actorIds: filters.actorIds.length === 0 ? undefined : [...filters.actorIds].sort().join(','),
    }),
    [filters],
  );

  const firstPagePath = withQuery(apiPath.audit(orgSlug), queryParams);

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
  const pageProblem = pagingError?.key === filterKey ? pagingError.cause : null;

  // Called from an event handler or from the scroll sentinel's observer
  // callback, never from a render, so the synchronous setState is fine — it is
  // what stops a second request for the same page.
  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setPagingError(null);

    api
      .get<AuditListResponse>(
        withQuery(apiPath.audit(orgSlug), { ...queryParams, cursor: nextCursor }),
      )
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
        // The cursor is kept: the rows already read stay, the offer of more
        // stays, and what stops is the *automatic* asking. Without this the
        // sentinel was still on screen, still intersecting, and re-observed on
        // every `loading` transition — so one 429 became a request per frame
        // against the endpoint that had just asked for less.
        setPagingError({ key: filterKey, cause });
      })
      .finally(() => setLoadingMore(false));
  }, [filterKey, orgSlug, queryParams, loadingMore, nextCursor]);

  // ── More rows on scroll, rather than on a click ──
  //
  // An audit log is read by scanning: the question is usually "when did this
  // start", and the answer is somewhere down the page. A button every fifty
  // rows made that a sequence of clicks, each one moving the button away from
  // the cursor that had just found it.
  const sentinel = useInfiniteScroll<HTMLDivElement>({
    onLoadMore: loadMore,
    hasMore: nextCursor !== null,
    loading: loadingMore,
    // Asking again is the reader's decision once a page has failed; see the
    // Retry beside the sentinel below.
    blocked: pageProblem !== null,
  });
  const scrollLoads = infiniteScrollSupported();

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
            <ActorFilter
              selected={filters.actorIds}
              members={members.members}
              truncated={members.truncated}
              onChange={(actorIds) => setFilters((f) => ({ ...f, actorIds }))}
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
            <p role="status" className="text-fg-subtle text-sm">
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
                        <TableCell className="text-fg-muted text-sm whitespace-nowrap">
                          <time
                            dateTime={toIsoString(event.createdAt)}
                            title={formatAbsoluteTime(event.createdAt)}
                          >
                            {formatRelativeTime(event.createdAt)}
                          </time>
                        </TableCell>
                        <TableCell>
                          <p className="text-fg truncate text-sm">{event.actorLabel ?? '—'}</p>
                          {event.ipAddress !== null ? (
                            <p className="text-fg-subtle font-mono text-sm">{event.ipAddress}</p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <code className="text-fg-muted font-mono text-sm">{event.action}</code>
                        </TableCell>
                        <TableCell>
                          {event.outcome === 'success' ? (
                            <span className="text-fg-muted text-sm">ok</span>
                          ) : (
                            <Badge tone={OUTCOME_TONE[event.outcome] ?? 'neutral'}>
                              {event.outcome}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-fg-muted max-w-64 truncate text-sm">
                          {describeEvent(event)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {nextCursor !== null ? (
                // The sentinel has to be in the document for the observer to
                // watch it, so it carries the "loading" line rather than being
                // swapped for one. The button is the fallback for a browser with
                // no `IntersectionObserver`; see `use-infinite-scroll.ts`.
                <div ref={sentinel} className="flex min-h-10 flex-col items-center gap-2">
                  {pageProblem !== null ? (
                    // Where the reader is: at the end of the rows, looking for
                    // the next ones. An alert at the top of the page would be
                    // a screen away from the gap it is about.
                    <>
                      <p role="status" className="text-danger-text text-sm">
                        Couldn’t load more — {errorMessage(pageProblem)}
                      </p>
                      <Button variant="secondary" onClick={loadMore}>
                        Retry
                      </Button>
                    </>
                  ) : scrollLoads ? (
                    <p role="status" className="text-fg-subtle text-sm">
                      {loadingMore ? 'Loading more events…' : ''}
                    </p>
                  ) : (
                    <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
                      Load more
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-fg-subtle text-sm">
                  That is every event in this window that matches.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The members the actor filter can offer, read to a stated horizon.
 *
 * Not `useApiResource`: that hook is one request, and this is up to
 * `ACTOR_MAX_PAGES` of them chained on the cursor the previous answer returned.
 * A failure resolves to an empty list rather than an error state — the filter is
 * a convenience over a log that is perfectly readable without it, and every row
 * already carries the actor it names.
 */
function useFilterableMembers(orgSlug: string): {
  members: readonly Member[];
  /** Whether there are members past the last page this read. */
  truncated: boolean;
} {
  const [state, setState] = useState<{
    orgSlug: string;
    members: readonly Member[];
    truncated: boolean;
  }>({ orgSlug: '', members: [], truncated: false });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const collected: Member[] = [];
      let cursor: string | null = null;
      let truncated = false;

      try {
        for (let page = 0; page < ACTOR_MAX_PAGES; page += 1) {
          const response: MemberListResponse = await api.get<MemberListResponse>(
            withQuery(apiPath.members(orgSlug), {
              limit: ACTOR_PAGE_SIZE,
              ...(cursor === null ? {} : { cursor }),
            }),
            { signal: controller.signal },
          );
          collected.push(...response.data);
          cursor = response.nextCursor;
          if (cursor === null) break;
          // The last page allowed, and the server says there is more behind it.
          if (page === ACTOR_MAX_PAGES - 1) truncated = true;
        }
      } catch {
        // Nothing from the thrown value is kept; see `lib/api.ts`.
      }

      if (controller.signal.aborted) return;
      setState({ orgSlug, members: collected, truncated });
    })();

    return () => controller.abort();
  }, [orgSlug]);

  // The same guard every other listing on this screen carries: an answer for
  // the organisation you have navigated away from is absent, not stale.
  return state.orgSlug === orgSlug
    ? { members: state.members, truncated: state.truncated }
    : { members: [], truncated: false };
}

/**
 * "Who", as a menu of email addresses with a tick beside each.
 *
 * ── Why a menu of checkboxes and not a `Select` ──
 * The other three filters are one-of-many, which is what a `Select` is for.
 * This one is any-of-many: an investigation narrows to the two or three people
 * it is about, and doing that through a single-value control means reading the
 * same window three times and merging it by hand. Radix's `CheckboxItem`
 * already has the semantics — `role="menuitemcheckbox"` with `aria-checked` —
 * and its typeahead makes a long list usable without a search box, because the
 * thing the reader is about to type is an address they already know.
 *
 * The menu stays open on select, because the point of it is to pick more than
 * one. "All users" is not a fourth option but the absence of the other three;
 * it is checked exactly when nothing else is, and choosing it clears them.
 *
 * ── What it lists ──
 * Current members, because those are the people whose addresses can be shown.
 * The log keeps events from users who have since been removed, and those rows
 * are still there, still attributed, and still reachable with no filter on —
 * they are simply not offered as a choice, since there is no list to take them
 * from. A filtered-out name is never silently dropped from the *result*: the
 * filter narrows by id, and an id that no longer belongs to a member is only
 * ever one the reader cannot have selected.
 */
function ActorFilter({
  selected,
  members,
  truncated,
  onChange,
}: {
  selected: readonly string[];
  members: readonly { userId: string; email: string; isYou: boolean }[];
  /** More members exist than were read. Printed, not hidden — see the note. */
  truncated: boolean;
  onChange: (next: readonly string[]) => void;
}) {
  const chosen = useMemo(() => new Set(selected), [selected]);

  // Sorted by address so the menu reads like a directory rather than like the
  // order the API happened to return, with the viewer first: "what did I do" is
  // the single most common reason to open this.
  const listed = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
        return a.email.localeCompare(b.email);
      }),
    [members],
  );

  function toggle(userId: string) {
    onChange(chosen.has(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
  }

  const label =
    selected.length === 0
      ? 'All users'
      : selected.length === 1
        ? (listed.find((member) => member.userId === selected[0])?.email ?? '1 user')
        : `${selected.length} users`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 w-44 justify-between font-normal"
          aria-label="Filter by user"
        >
          {/* `truncate` with `min-w-0`: an address is as long as somebody's
              employer made it, and it must not push the chevron out of the
              trigger or widen this control past the others. */}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon aria-hidden="true" className="text-fg-subtle size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="max-h-80 w-72">
        <DropdownMenuCheckboxItem
          checked={selected.length === 0}
          onCheckedChange={() => onChange([])}
          onSelect={(event) => event.preventDefault()}
        >
          All users
        </DropdownMenuCheckboxItem>

        {listed.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Members</DropdownMenuLabel>
            {listed.map((member) => (
              <DropdownMenuCheckboxItem
                key={member.userId}
                checked={chosen.has(member.userId)}
                onCheckedChange={() => toggle(member.userId)}
                // Kept open: picking two addresses should not cost two openings
                // of the same menu.
                onSelect={(event) => event.preventDefault()}
              >
                <span className="min-w-0 flex-1 truncate">{member.email}</span>
                {member.isYou ? <span className="text-fg-subtle text-xs">you</span> : null}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}

        {truncated ? (
          // The horizon, said out loud. A menu that silently stops at its own
          // page boundary makes "that person did nothing" and "that person was
          // never offered" look identical, which on an audit screen is the one
          // confusion that matters.
          <>
            <DropdownMenuSeparator />
            <p className="text-fg-subtle px-2 py-1.5 text-sm">
              The first {listed.length} members are listed. Anyone past that is still in the log,
              and their events show with no filter on.
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
