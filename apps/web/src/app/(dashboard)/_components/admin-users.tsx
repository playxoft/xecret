'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
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
  UsersIcon,
} from '@/components/ui';
import type { AdminAccountPayload } from '@/server/schemas/admin';
import { apiPath, appPath, withQuery } from '../_lib/paths';
import {
  count,
  LoadMore,
  Moment,
  signInMethodLabel,
  useAdminList,
  VerifiedBadge,
} from './admin-lists';
import { ErrorState } from './resource-states';

/**
 * The Users tab: every account, newest first, fifty at a time — who signed
 * up, when, whether they proved their address, when and how they last signed
 * in, and how many organisations they are in. A search narrows it to the
 * accounts whose address contains what was typed, in any case.
 *
 * The account data and nothing more: no address a session came from, no
 * browser, no device, no avatar. Each row opens the account's own page
 * (`/app/admin/users/{id}`), which lists its organisations.
 */

export function UsersTab({
  query,
  onSearch,
}: {
  /** What was last searched for — held by the page, so switching tabs keeps it. `null` lists every one. */
  query: string | null;
  onSearch: (query: string | null) => void;
}) {
  const [typed, setTyped] = useState(query ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const path =
    query === null ? apiPath.adminUsers() : withQuery(apiPath.adminUsers(), { q: query });
  const list = useAdminList<'users', AdminAccountPayload>(path, 'users');

  function search(event: React.FormEvent) {
    event.preventDefault();
    const q = typed.trim();
    if (q.length === 0) {
      onSearch(null);
      return;
    }
    if (q.length < 3) {
      setProblem('Type at least three characters of an address.');
      return;
    }
    setProblem(null);
    if (q === query) list.reload();
    else onSearch(q);
  }

  function clear() {
    setTyped('');
    setProblem(null);
    onSearch(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={search} noValidate className="flex flex-col gap-1.5" role="search">
        <Field
          label="Find an account"
          error={problem}
          hint="Any part of the address they sign in with, in any case."
        >
          <div className="flex flex-wrap gap-2">
            <Input
              type="search"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(null);
              }}
              placeholder="ada@ or example.com"
              startIcon={<SearchIcon />}
              autoComplete="off"
              spellCheck={false}
              className="min-w-64"
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {query !== null ? (
              <Button type="button" variant="ghost" onClick={clear}>
                Show every account
              </Button>
            ) : null}
          </div>
        </Field>
      </form>

      {list.error !== null ? (
        <ErrorState subject="the accounts" error={list.error} onRetry={list.reload} />
      ) : list.rows === null ? (
        <div aria-busy="true" aria-label="Loading the accounts">
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : list.rows.length === 0 ? (
        <EmptyState
          icon={query === null ? <UsersIcon /> : <SearchIcon />}
          title={query === null ? 'No accounts yet' : `No address contains “${query}”`}
          description={
            query === null
              ? 'Every account made on this deployment is listed here, the newest first.'
              : 'Deleted accounts are never listed.'
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <TableContainer
            aria-label={query === null ? 'Every account, newest first' : `Accounts for ${query}`}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Organisations</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={appPath.adminUser(account.id)}
                          className="text-fg decoration-line-strong hover:decoration-fg text-sm font-medium break-all underline-offset-4 hover:underline"
                        >
                          {account.email}
                        </Link>
                        <VerifiedBadge verified={account.emailVerified} />
                      </div>
                      {account.displayName !== null ? (
                        <p className="text-fg-subtle text-sm">{account.displayName}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Moment value={account.signedUpAt} />
                    </TableCell>
                    <TableCell className="text-sm">
                      <Moment value={account.lastSignInAt} never="Never" />
                    </TableCell>
                    <TableCell className="text-fg-muted text-sm whitespace-nowrap">
                      {signInMethodLabel(account.lastSignInMethod)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {count(account.organizationCount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <LoadMore list={list} noun={query === null ? 'accounts' : 'matching accounts'} />
        </div>
      )}
    </div>
  );
}
