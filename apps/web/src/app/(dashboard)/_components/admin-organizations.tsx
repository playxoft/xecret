'use client';

import { useState } from 'react';

import { formatAbsoluteTime } from '@/lib/format';
import { ROLE_LABELS } from '@/components/members/types';
import { Badge, Button, EmptyState, Field, Input, SearchIcon, Skeleton } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import type { OrgRole } from '@xecret/core/authz';
import type { AdminOrganizationPayload } from '@/server/schemas/admin';
import { apiPath, withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import {
  EndGrantDialog,
  GrantDialog,
  grantSummary,
  grantTargetOf,
  useDialogTarget,
} from './admin-grant-dialogs';
import type { GrantTarget } from './admin-grant-dialogs';
import { ErrorState } from './resource-states';

/**
 * The Organisations tab: find one, and give it a free plan or end the one it
 * has.
 *
 * ── Found by an address or a slug, never browsed ──
 * There is no list of every organisation to scroll. An admin arrives with a
 * person ("the owner wrote in from ada@acme.dev") or an organisation's address
 * (`/app/acme`), so the search takes exactly those: an owner's or member's
 * email address, or the slug. Anything shorter than three characters is not
 * either, and is answered here rather than sent.
 *
 * Each result says what the grant dialog has to know before anybody opens it:
 * the plan and how it came to be, whether Dodo bills it — a grant over that
 * takes it off its subscription — and what it allows now.
 */

const STATUS: Record<AdminOrganizationPayload['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  trialing: { label: 'Trial', tone: 'success' },
  past_due: { label: 'Payment overdue', tone: 'warning' },
  on_hold: { label: 'Payment failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Ended', tone: 'neutral' },
};

const count = (value: number) => value.toLocaleString('en-GB');

/** The role, as the members screen names it; a role this client does not know, as sent. */
function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as OrgRole] : role;
}

export function OrganizationsTab({
  query,
  onSearch,
}: {
  /** What was last searched for — held by the page, so switching tabs keeps it. */
  query: string | null;
  onSearch: (query: string) => void;
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
      setProblem('Type at least three characters — an email address or an organisation’s slug.');
      return;
    }
    setProblem(null);
    // The same search again is a re-read: somebody pressing Search twice
    // wants the answer as it is now.
    if (q === query) reload();
    else onSearch(q);
  }

  const organizations = results.data?.organizations ?? null;

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={search} noValidate className="flex flex-col gap-1.5" role="search">
        <Field
          label="Find an organisation"
          error={problem}
          hint="An owner’s or a member’s email address, or the organisation’s slug — the part after /app/."
        >
          <div className="flex flex-wrap gap-2">
            <Input
              type="search"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(null);
              }}
              placeholder="ada@example.com or acme"
              startIcon={<SearchIcon />}
              autoComplete="off"
              spellCheck={false}
              className="min-w-64"
            />
            <Button type="submit" variant="secondary" loading={results.loading}>
              Search
            </Button>
          </div>
        </Field>
      </form>

      {query === null ? null : results.error !== null ? (
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
          description="Nobody signs in with that address, and no organisation has that slug. An address has to match exactly; so does a slug."
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

function OrganizationResult({
  organization,
  onGrant,
  onEnd,
}: {
  organization: AdminOrganizationPayload;
  onGrant: () => void;
  onEnd: () => void;
}) {
  const status = STATUS[organization.status];
  const granted = organization.grant !== null;
  // An Enterprise contract or another arrangement support made by hand: a paid
  // plan with nothing at Dodo, and no grant record to say how long. A grant
  // replaces it like any other.
  const arranged = organization.managedBy === 'support' && !granted;

  return (
    <li className="border-line bg-surface flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-fg text-[0.9375rem] font-semibold">{organization.name}</p>
          <code className="text-fg-subtle font-mono text-sm">{organization.slug}</code>
          {organization.role !== null ? (
            <span className="text-fg-muted text-sm">
              · their role: {roleLabel(organization.role)}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg">{grantSummary(organization.plan, organization.grant)}</span>
          {organization.plan !== 'free' && !granted ? (
            <Badge tone={status.tone}>{status.label}</Badge>
          ) : null}
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
