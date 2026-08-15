'use client';

import Link from 'next/link';

import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import {
  CheckIcon,
  ChevronUpDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PlusIcon,
} from '@/components/ui';

export interface ShellOrganization {
  slug: string;
  name: string;
  /** The viewer's role here. Shown so it is obvious before, not after, an action is denied. */
  role: string;
  /**
   * Where selecting this organisation goes.
   *
   * A resolved href rather than a callback: the shell is rendered from Server
   * Components, and a function prop cannot cross that boundary — an element or
   * a string can.
   */
  href: string;
}

export interface OrgSwitcherProps {
  organizations: readonly ShellOrganization[];
  currentSlug: string;
  /** Adds a "New organisation" item when provided. */
  createHref?: string;
  className?: string;
}

export function OrgSwitcher({
  organizations,
  currentSlug,
  createHref,
  className,
}: OrgSwitcherProps) {
  const current = organizations.find((org) => org.slug === currentSlug) ?? organizations[0];
  if (!current) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'border-line hover:bg-surface-hover data-[state=open]:bg-surface-hover flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
          className,
        )}
        aria-label={`Organisation: ${current.name}. Switch organisation`}
      >
        <span
          aria-hidden="true"
          className="bg-accent-tint text-accent-text grid size-6 shrink-0 place-items-center rounded-md text-sm font-semibold"
        >
          {initials(current.name)}
        </span>
        <span className="x-sidebar-wide min-w-0 flex-1">
          <span className="text-fg block truncate text-sm font-medium">{current.name}</span>
          <span className="text-fg-subtle block truncate text-sm capitalize">{current.role}</span>
        </span>
        <ChevronUpDownIcon className="x-sidebar-wide text-fg-subtle size-3.5 shrink-0" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organisations</DropdownMenuLabel>
        {organizations.map((org) => (
          <DropdownMenuItem key={org.slug} asChild>
            <Link href={org.href} className="justify-between">
              <span className="min-w-0 truncate">{org.name}</span>
              {org.slug === current.slug ? (
                <CheckIcon className="text-accent-text size-4 shrink-0" />
              ) : (
                <span className="text-fg-subtle shrink-0 text-sm capitalize">{org.role}</span>
              )}
            </Link>
          </DropdownMenuItem>
        ))}
        {createHref ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={createHref}>
                <PlusIcon className="size-4" />
                New organisation
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
