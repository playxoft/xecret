'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';
import {
  CheckIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Kbd,
  PlusIcon,
  SearchIcon,
} from '@/components/ui';
import { askBeforeLeaving, isPlainLeftClick } from '@/components/ui/leave-guard';
import type { ShellOrganization } from './org-switcher';

/**
 * Switch workspace, from anywhere, with `G`.
 *
 * ── Why this exists beside the sidebar switcher ──
 * The switcher in the sidebar is the *discoverable* way to change organisation
 * and it is 240px away from wherever the cursor is. People who work in three
 * tenants change between them dozens of times a day, and asking them to travel
 * to the top-left corner each time is the difference between a switcher and a
 * habit. So this is the same list, raised in the middle of the screen under
 * one key, with a filter box focused on open — the shape every application
 * with more than a handful of workspaces converges on.
 *
 * ── Centre, not a corner ──
 * A palette that opens at the edge makes the reader's eye leave whatever they
 * were reading to find it. The dialog primitive already centres, which is the
 * whole reason this is a `Dialog` rather than a popover anchored to the
 * sidebar trigger.
 *
 * ── Keyboard ──
 * The filter is focused on open, so typing narrows immediately. `↓` from the
 * filter steps into the list and `↑`/`↓` walk it; every row is a real link, so
 * `Enter` navigates, ⌘/Ctrl-click opens a tab, and nothing here has to
 * re-implement what an anchor already does. `Escape` closes, from Radix.
 *
 * `G` itself is registered by `AppShell` through `useGlobalShortcut`, which
 * stands down inside text fields and under open overlays — including this one,
 * so the key cannot re-open a dialog that is already up.
 */

export interface WorkspaceSwitcherDialogProps {
  organizations: readonly ShellOrganization[];
  currentSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the create-organisation dialog. Absent hides the row. */
  onCreate?: () => void;
}

export function WorkspaceSwitcherDialog({
  organizations,
  currentSlug,
  open,
  onOpenChange,
  onCreate,
}: WorkspaceSwitcherDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0" hideCloseButton>
        {/* Remounted on every open by Radix, which is what resets the filter
            without an effect having to clear it a render later. */}
        <WorkspaceList
          organizations={organizations}
          currentSlug={currentSlug}
          onOpenChange={onOpenChange}
          {...(onCreate === undefined ? {} : { onCreate })}
        />
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceList({
  organizations,
  currentSlug,
  onOpenChange,
  onCreate,
}: {
  organizations: readonly ShellOrganization[];
  currentSlug: string;
  onOpenChange: (open: boolean) => void;
  onCreate?: () => void;
}) {
  const [query, setQuery] = useState('');
  // The rendered rows, so `↑`/`↓` can move focus between them. Indexed by
  // position in the filtered list, and rebuilt as the filter narrows.
  const rows = useRef<(HTMLAnchorElement | null)[]>([]);

  const needle = query.trim().toLowerCase();
  const matches = organizations.filter(
    (organization) =>
      needle.length === 0 ||
      organization.name.toLowerCase().includes(needle) ||
      organization.slug.toLowerCase().includes(needle),
  );

  function focusRow(index: number) {
    const bounded = Math.max(0, Math.min(index, matches.length - 1));
    rows.current[bounded]?.focus();
  }

  return (
    <>
      <DialogTitle className="sr-only">Switch workspace</DialogTitle>
      <DialogDescription className="sr-only">
        Filter your organisations and choose one to switch to.
      </DialogDescription>

      <div className="border-line-subtle border-b p-2">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            focusRow(0);
          }}
          placeholder="Search organisations…"
          aria-label="Search organisations"
          autoComplete="off"
          autoFocus
          startIcon={<SearchIcon className="size-4" />}
        />
      </div>

      <div className="max-h-80 overflow-y-auto p-2">
        {matches.length === 0 ? (
          <p className="text-fg-subtle px-2 py-6 text-center text-sm">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="flex flex-col">
            {matches.map((organization, index) => (
              <li key={organization.slug}>
                <Link
                  href={organization.href}
                  ref={(node) => {
                    rows.current[index] = node;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                    event.preventDefault();
                    focusRow(index + (event.key === 'ArrowDown' ? 1 : -1));
                  }}
                  onClick={(event) => {
                    // A modified click opens a new tab and leaves this one — and
                    // the unsaved work in it — exactly where it is, so there is
                    // nothing to guard and preventing the default would only
                    // break open-in-new-tab. The rule is the guard's own, so the
                    // two cannot disagree about what a plain click is.
                    if (!isPlainLeftClick(event)) return;
                    // Otherwise the same guard the nav shortcuts use: leaving a
                    // screen holding unsaved secrets must ask first, whichever
                    // door the navigation goes through.
                    if (askBeforeLeaving(organization.href)) {
                      event.preventDefault();
                      return;
                    }
                    onOpenChange(false);
                  }}
                  className={cn(
                    'hover:bg-surface-hover flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                    organization.slug === currentSlug && 'bg-surface-hover',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="bg-accent-tint text-accent-text grid size-7 shrink-0 place-items-center rounded-md text-sm font-semibold"
                  >
                    {initials(organization.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-fg block truncate text-sm font-medium">
                      {organization.name}
                    </span>
                    <span className="text-fg-subtle block truncate text-sm capitalize">
                      {organization.role}
                    </span>
                  </span>
                  {organization.slug === currentSlug ? (
                    <CheckIcon className="text-accent-text size-4 shrink-0" />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {onCreate ? (
        <div className="border-line-subtle border-t p-2">
          <button
            type="button"
            onClick={() => {
              // Closed first: two stacked dialogs would leave this one's focus
              // trap between the create form and the keyboard.
              onOpenChange(false);
              onCreate();
            }}
            className="hover:bg-surface-hover text-fg flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors"
          >
            <span
              aria-hidden="true"
              className="border-line text-fg-subtle grid size-7 shrink-0 place-items-center rounded-md border border-dashed"
            >
              <PlusIcon className="size-4" />
            </span>
            New organisation
          </button>
        </div>
      ) : null}

      <div className="border-line-subtle text-fg-subtle flex items-center gap-1.5 border-t px-3 py-2 text-sm">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span>to move</span>
        <Kbd className="ml-1.5">↵</Kbd>
        <span>to switch</span>
        <Kbd className="ml-1.5">Esc</Kbd>
        <span>to close</span>
      </div>
    </>
  );
}
