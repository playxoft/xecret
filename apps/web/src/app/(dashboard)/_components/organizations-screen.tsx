'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { initials } from '@/lib/format';
import { CreateOrganizationDialog } from '@/components/organizations';
import { ArrowRightIcon, Button, PlusIcon } from '@/components/ui';
import { appPath } from '../_lib/paths';
import { useSession } from './session';

/**
 * `/app` — the entry point, which usually redirects.
 *
 * Almost everybody is a member of exactly one organisation, so this screen's
 * normal behaviour is to be invisible: it replaces itself with that
 * organisation's projects. `replace` rather than `push`, so Back returns to
 * wherever the user came from instead of bouncing them straight through here
 * again.
 *
 * The picker only ever renders for somebody who really does belong to several,
 * and it uses the session the shell has already fetched rather than asking
 * `/api/orgs` for the same answer a second time.
 */
export function OrganizationsScreen() {
  const router = useRouter();
  const { organizations, refresh } = useSession();
  const [creating, setCreating] = useState(false);
  const only = organizations.length === 1 ? organizations[0] : undefined;

  useEffect(() => {
    if (only) router.replace(appPath.org(only.slug));
  }, [only, router]);

  if (only) {
    // Announced politely rather than left blank: the redirect is one tick away,
    // but on a slow device that is long enough to look broken.
    return (
      <p role="status" className="text-fg-muted text-sm">
        Opening {only.name}…
      </p>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-fg text-xl font-semibold tracking-tight">Choose an organisation</h1>
          <p className="text-fg-muted mt-1.5 text-sm leading-6">
            You are a member of {organizations.length} organisations. Your role differs between
            them.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0" onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" />
          New organisation
        </Button>
      </div>

      <ul className="mt-6 flex flex-col gap-2">
        {organizations.map((organization) => (
          <li key={organization.slug}>
            <Link
              href={appPath.org(organization.slug)}
              className="border-line bg-surface hover:border-line-strong hover:bg-surface-hover flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors"
            >
              <span
                aria-hidden="true"
                className="bg-accent-tint text-accent-text grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold"
              >
                {initials(organization.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fg block truncate text-sm font-medium">
                  {organization.name}
                </span>
                <span className="text-fg-subtle block truncate text-sm">
                  <span className="font-mono">{organization.slug}</span> · {organization.role}
                </span>
              </span>
              <ArrowRightIcon className="text-fg-subtle size-4 shrink-0" />
            </Link>
          </li>
        ))}
      </ul>

      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} onCreated={refresh} />
    </div>
  );
}
