'use client';

import Link from 'next/link';
import { useState } from 'react';

import { formatAbsoluteTime } from '@/lib/format';
import {
  Badge,
  BoxIcon,
  Button,
  EmptyState,
  Field,
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
} from '@/components/ui';
import type { AdminOrganizationPayload } from '@/server/schemas/admin';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import {
  EndGrantDialog,
  GrantDialog,
  grantSummary,
  grantTargetOf,
  useDialogTarget,
} from './admin-grant-dialogs';
import type { GrantTarget } from './admin-grant-dialogs';
import {
  count,
  LoadMore,
  Moment,
  ownersText,
  PlanBadge,
  roleLabel,
  statusOf,
  useAdminList,
} from './admin-lists';
import { ErrorState } from './resource-states';

/**
 * The Organisations tab: every organisation, newest first, and a search for
 * the one somebody wrote in about — and, from a search result or an
 * organisation's own page, a free plan given or ended.
 *
 * ── The list ──
 * Every live organisation, fifty at a time with "Load more": its name and
 * id, its owner's address, its plan, and how many members, projects,
 * environments and secrets it has. Counts, never names — what a customer calls
 * its projects is theirs, and the server never sends it. Each row opens the
 * organisation's page (`/app/admin/organizations/{id}`), where its members
 * are.
 *
 * ── The search ──
 * An admin often arrives with a person ("the owner wrote in from
 * ada@acme.dev") or an organisation's address (`/app/{id}`), so the search
 * takes exactly those: an owner's or member's email address, or the
 * organisation's id. A legacy slug, from an address older than ids, is still
 * found too, though nothing shows one any more. Anything shorter than three
 * characters is none of these, and is answered here rather than sent.
 *
 * Each search result says what the grant dialog has to know before anybody
 * opens it: the plan and how it came to be, whether Dodo bills it — a grant
 * over that takes it off its subscription — and what it allows now.
 */

export function OrganizationsTab({
  query,
  onSearch,
}: {
  /** What was last searched for — held by the page, so switching tabs keeps it. `null` lists every one. */
  query: string | null;
  onSearch: (query: string | null) => void;
}) {
  const [typed, setTyped] = useState(query ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const results = useApiResource<{ organizations: AdminOrganizationPayload[] }>(
    query === null ? null : withQuery(apiPath.adminOrganizations(), { q: query }),
  );

  const granting = useDialogTarget<GrantTarget>();
  const ending = useDialogTarget<GrantTarget>();
  const reload = () => void results.reload();

  function search(event: React.FormEvent) {
    event.preventDefault();
    const q = typed.trim();
    if (q.length < 3) {
      setProblem('Type at least three characters: an email address or an organisation ID.');
      return;
    }
    setProblem(null);
    // The same search again is a re-read: somebody pressing Search twice
    // wants the answer as it is now.
    if (q === query) reload();
    else onSearch(q);
  }

  function clear() {
    setTyped('');
    setProblem(null);
    onSearch(null);
  }

  const organizations = results.data?.organizations ?? null;

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={search} noValidate className="flex flex-col gap-1.5" role="search">
        <Field
          label="Find an organisation"
          error={problem}
          hint="An owner’s or a member’s email address, or the organisation ID (the part after /app/)."
        >
          <div className="flex flex-wrap gap-2">
            <Input
              type="search"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(null);
              }}
              placeholder="ada@example.com or an organisation ID"
              startIcon={<SearchIcon />}
              autoComplete="off"
              spellCheck={false}
              className="min-w-64"
            />
            <Button type="submit" variant="secondary" loading={results.loading}>
              Search
            </Button>
            {query !== null ? (
              <Button type="button" variant="ghost" onClick={clear}>
                Show every organisation
              </Button>
            ) : null}
          </div>
        </Field>
      </form>

      {query === null ? (
        <OrganizationList />
      ) : results.error !== null ? (
        <ErrorState subject="organisations" error={results.error} onRetry={reload} />
      ) : organizations === null ? (
        <div aria-busy="true" aria-label="Searching" className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : organizations.length === 0 ? (
        <EmptyState
          icon={<SearchIcon />}
          title={`Nothing found for “${query}”`}
          description="Nobody signs in with that address, and no organisation has that ID. An address has to match exactly, and so does an ID."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={`Organisations for ${query}`}>
          {organizations.map((organization) => (
            <OrganizationResult
              key={organization.id}
              organization={organization}
              onGrant={() => granting.show(grantTargetOf(organization))}
              onEnd={() => ending.show(grantTargetOf(organization))}
            />
          ))}
        </ul>
      )}

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

/** Every live organisation, newest first, a page at a time. */
function OrganizationList() {
  const list = useAdminList<'organizations', AdminOrganizationPayload>(
    apiPath.adminOrganizations(),
    'organizations',
  );

  if (list.error !== null) {
    return <ErrorState subject="the organisations" error={list.error} onRetry={list.reload} />;
  }
  if (list.rows === null) {
    return (
      <div aria-busy="true" aria-label="Loading the organisations">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (list.rows.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="No organisations yet"
        description="Every organisation made on this deployment is listed here, the newest first."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <TableContainer aria-label="Every organisation, newest first">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organisation</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Projects</TableHead>
              <TableHead className="text-right">Environments</TableHead>
              <TableHead className="text-right">Secrets</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((organization) => (
              <TableRow key={organization.id}>
                <TableCell>
                  <Link
                    href={appPath.adminOrganization(organization.id)}
                    className="text-fg hover:decoration-fg decoration-line-strong text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {organization.name}
                  </Link>
                  <p className="text-fg-subtle font-mono text-sm break-all">{organization.id}</p>
                </TableCell>
                <TableCell className="text-fg-muted max-w-64 truncate text-sm">
                  {ownersText(organization.ownerEmails)}
                </TableCell>
                <TableCell>
                  <PlanBadge organization={organization} />
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {count(organization.counts.members)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {count(organization.counts.projects)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {count(organization.counts.environments)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {count(organization.counts.secrets)}
                </TableCell>
                <TableCell className="text-sm">
                  <Moment value={organization.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <LoadMore list={list} noun="organisations" />
    </div>
  );
}

function OrganizationResult({
  organization,
  onGrant,
  onEnd,
}: {
  organization: AdminOrganizationPayload;
  onGrant: () => void;
  onEnd: () => void;
}) {
  const status = statusOf(organization);
  const granted = organization.grant !== null;
  // An Enterprise contract or another arrangement support made by hand: a paid
  // plan with nothing at Dodo, and no grant record to say how long. A grant
  // replaces it like any other.
  const arranged = organization.managedBy === 'support' && !granted;

  return (
    <li className="border-line bg-surface flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link
            href={appPath.adminOrganization(organization.id)}
            className="text-fg decoration-line-strong hover:decoration-fg text-[0.9375rem] font-semibold underline-offset-4 hover:underline"
          >
            {organization.name}
          </Link>
          <code className="text-fg-subtle font-mono text-sm break-all">{organization.id}</code>
          {organization.role !== null ? (
            <span className="text-fg-muted text-sm">
              · their role: {roleLabel(organization.role)}
            </span>
          ) : null}
        </div>

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
          {arranged ? <Badge tone="neutral">Arranged by support</Badge> : null}
        </div>

        <p className="text-fg-subtle text-sm">
          Up to {count(organization.seats.limit)} members
          {organization.billedByDodo ? ` · ${count(organization.seats.billed)} seats billed` : ''}
          {' · '}created {formatAbsoluteTime(organization.createdAt)}
        </p>
        <p className="text-fg-subtle text-sm">
          Owner: {ownersText(organization.ownerEmails)} · {count(organization.counts.members)}{' '}
          members · {count(organization.counts.projects)} projects ·{' '}
          {count(organization.counts.secrets)} secrets
        </p>
        {organization.grant?.note ? (
          <p className="text-fg-muted text-sm">{organization.grant.note}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant={granted ? 'secondary' : 'primary'} size="sm" onClick={onGrant}>
          {granted ? 'Change the free plan' : 'Give a free plan'}
        </Button>
        {granted ? (
          <Button
            variant="danger-outline"
            size="sm"
            aria-label={`End ${organization.name}’s free plan`}
            onClick={onEnd}
          >
            End it
          </Button>
        ) : null}
      </div>
    </li>
  );
}
