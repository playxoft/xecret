'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { planName } from '@/components/plans/plan-copy';
import { ROLE_LABELS } from '@/components/members/types';
import { Badge, Button, Card } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import type { OrgRole } from '@xecret/core/authz';
import type { AdminAccountPayload, AdminOrganizationPayload } from '@/server/schemas/admin';
import { withQuery } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';

/**
 * What the admin page's monitoring tabs and pages share: a newest-first list
 * read a page at a time, and the small pieces every one of them draws the same
 * way — a count, a plan, a moment, a sign-in method.
 *
 * ── A page at a time, and only when asked ──
 * The first page is read when the list is opened; the next one when somebody
 * presses "Load more", never on a timer and never by scrolling past the end.
 * The database is on a plan that bills by the hour it is awake, and a staff
 * page that kept it awake would cost more than the product it watches.
 */

export const count = (value: number) => value.toLocaleString('en-GB');

/** The role, as the members screen names it; a role this client does not know, as sent. */
export function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as OrgRole] : role;
}

/** How a session signed in, in a word or two. */
export const SIGN_IN_METHOD_LABELS: Readonly<
  Record<NonNullable<AdminAccountPayload['lastSignInMethod']>, string>
> = {
  password: 'Password',
  oauth: 'Google',
  sso: 'Single sign-on',
  magic_auth: 'Emailed code',
  passkey: 'Passkey',
  other: 'Other',
};

export function signInMethodLabel(method: AdminAccountPayload['lastSignInMethod']): string {
  return method === null ? 'None' : (SIGN_IN_METHOD_LABELS[method] ?? method);
}

const STATUS: Record<AdminOrganizationPayload['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  trialing: { label: 'Trial', tone: 'success' },
  past_due: { label: 'Payment overdue', tone: 'warning' },
  on_hold: { label: 'Payment failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Ended', tone: 'neutral' },
};

/** The status, for a paid plan that is not a grant; `null` for Free or a grant, which have none worth saying. */
export function statusOf(organization: AdminOrganizationPayload) {
  return organization.plan !== 'free' && organization.grant === null
    ? STATUS[organization.status]
    : null;
}

/** "ada@example.com", "ada@example.com and 2 more", or "No owner" for one whose owners are all gone. */
export function ownersText(ownerEmails: readonly string[]): string {
  const [first, ...others] = ownerEmails;
  if (first === undefined) return 'No owner';
  return others.length === 0 ? first : `${first} and ${others.length} more`;
}

/** The plan, as a badge: a paid plan in the accent colour, a free one plain, and a grant says so. */
export function PlanBadge({ organization }: { organization: AdminOrganizationPayload }) {
  const tone: BadgeTone = organization.plan === 'free' ? 'neutral' : 'accent';
  return (
    <Badge tone={tone}>
      {planName(organization.plan)}
      {organization.grant !== null ? ' · free' : ''}
    </Badge>
  );
}

/** Whether the account proved it owns its address. */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge tone="success">Verified</Badge>
  ) : (
    <Badge tone="warning">Not verified</Badge>
  );
}

/** A moment, absolute, with how long ago underneath — or "Never" when there is none. */
export function Moment({ value, never = 'Never' }: { value: string | null; never?: string }) {
  if (value === null) return <span className="text-fg-subtle">{never}</span>;
  return (
    <>
      <time dateTime={toIsoString(value)} className="text-fg block whitespace-nowrap">
        {formatAbsoluteTime(value)}
      </time>
      <span className="text-fg-subtle block whitespace-nowrap">{formatRelativeTime(value)}</span>
    </>
  );
}

/** One figure, large, with what it counts beneath it. */
export function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1 px-4 py-3.5">
      <p className="text-fg-muted text-sm">{label}</p>
      <p className="text-fg text-2xl font-semibold tracking-tight tabular-nums">{count(value)}</p>
      {hint !== undefined ? <p className="text-fg-subtle text-sm">{hint}</p> : null}
    </Card>
  );
}

/** "← All organisations", back to the tab a detail page was opened from. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg self-start text-sm underline underline-offset-4"
    >
      <span aria-hidden="true">← </span>
      {children}
    </Link>
  );
}

/** A page of any admin list: its rows under `key`, and the cursor for the next. */
type Page<K extends string, Row> = { [key in K]: Row[] } & { nextCursor: string | null };

export interface AdminList<Row> {
  /** Every row read so far, in the server's order; `null` until the first page lands. */
  rows: Row[] | null;
  error: unknown;
  /** Whether there is another page to ask for. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last "Load more" failed; the rows already read stay. */
  moreError: unknown;
  loadMore: () => void;
  /** Reads the first page again, and forgets every page after it. */
  reload: () => void;
}

/**
 * A newest-first list, read a page at a time: the first page through
 * `useApiResource`, each further one on `loadMore`, with the cursor the page
 * before it answered with.
 *
 * Every page read after the first carries the path it belongs to, as
 * `useApiResource`'s result does, so a list whose path changed — a new search
 * — never shows the old one's later pages under the new one's first.
 */
export function useAdminList<K extends string, Row>(path: string | null, key: K): AdminList<Row> {
  const first = useApiResource<Page<K, Row>>(path);
  const [more, setMore] = useState<{ path: string; rows: Row[]; nextCursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<{ path: string; cause: unknown } | null>(null);

  const mine = more !== null && more.path === path ? more : null;
  const firstRows = first.data?.[key] ?? null;
  const rows = firstRows === null ? null : mine === null ? firstRows : [...firstRows, ...mine.rows];
  const nextCursor = mine !== null ? mine.nextCursor : (first.data?.nextCursor ?? null);

  const loadMore = useCallback(() => {
    if (path === null || nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    api
      .get<Page<K, Row>>(withQuery(path, { cursor: nextCursor }))
      .then((page) => {
        setMore((previous) => ({
          path,
          rows: [
            ...(previous !== null && previous.path === path ? previous.rows : []),
            ...page[key],
          ],
          nextCursor: page.nextCursor,
        }));
      })
      .catch((cause: unknown) => setMoreError({ path, cause }))
      .finally(() => setLoadingMore(false));
  }, [path, key, nextCursor, loadingMore]);

  const reloadFirst = first.reload;
  const reload = useCallback(() => {
    setMore(null);
    setMoreError(null);
    void reloadFirst();
  }, [reloadFirst]);

  return {
    rows,
    error: first.error,
    hasMore: nextCursor !== null,
    loadingMore,
    moreError: moreError !== null && moreError.path === path ? moreError.cause : null,
    loadMore,
    reload,
  };
}

/** The end of a list: "Load more" while there is more, and the reason when a page would not load. */
export function LoadMore({
  list,
  noun,
}: {
  list: Pick<AdminList<unknown>, 'hasMore' | 'loadingMore' | 'moreError' | 'loadMore'>;
  /** "organisations", "accounts" — for the line under the last page. */
  noun: string;
}) {
  if (!list.hasMore) {
    return <p className="text-fg-subtle text-center text-sm">That is every one of the {noun}.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      {list.moreError !== null ? (
        <p role="status" className="text-danger-text text-sm">
          Couldn’t load more: {errorMessage(list.moreError)}
        </p>
      ) : null}
      <Button variant="secondary" loading={list.loadingMore} onClick={list.loadMore}>
        {list.moreError !== null ? 'Retry' : 'Load more'}
      </Button>
    </div>
  );
}
