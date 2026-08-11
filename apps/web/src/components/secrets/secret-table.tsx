'use client';

import { useCallback, useMemo, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ChevronUpDownIcon,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  KeyIcon,
  SearchIcon,
  SecretValue,
  SettingsIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import { Actor } from './actor';
import { SecretDialog } from './secret-dialog';
import { VersionHistoryDialog } from './version-history-dialog';
import type { RevealedSecret, SecretSummary } from './types';

export interface SecretTableProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  secrets: readonly SecretSummary[];
  /** Present when the environment holds more than one page. */
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
  onChanged: () => void;
}

type SortKey = 'name' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

/**
 * The environment's secrets. The main screen of the product.
 *
 * ── Three rules this table exists to hold ──
 *
 *  1. **A stored value is never on screen until somebody asks for it.** Every
 *     row renders a fixed-length mask whose length is unrelated to the real one,
 *     because length distinguishes a 16-character API key from a 64-character
 *     token and turns "unknown credential" into "AWS access key, brute-forceable
 *     offline at this cost".
 *  2. **A reveal always goes through the audited endpoint.** `SecretValue` calls
 *     `onReveal` on every reveal and every copy, and the callback below always
 *     issues `GET …/secrets/{name}`, which decrypts and writes a
 *     `secret.revealed` record each time. Caching the plaintext after the first
 *     reveal would make the audit trail claim one read where six happened — and
 *     "who read this, and when" is the question this product exists to answer.
 *  3. **Copy never renders.** The copy button fetches its own plaintext and
 *     writes it straight to the clipboard; the common case is pasting into a
 *     terminal, and showing it on the way there is exposure that buys nothing.
 *
 * ── Keyboard and screen reader ──
 * A real `<table>`, so a screen reader announces row and column context as the
 * user moves ("row 4 of 60, Name, DATABASE_URL"). Sortable columns are buttons
 * inside their `<th>` and the `<th>` carries `aria-sort`, which is the only part
 * a screen reader reads — the arrow glyph is decorative. Every per-row control
 * names its row ("Reveal the value of DATABASE_URL"), because "Reveal" repeated
 * sixty times is unusable. Filtering announces its result count through a polite
 * live region rather than silently changing the number of rows under the cursor.
 */
export function SecretTable({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  secrets,
  onLoadMore,
  loadingMore,
  onChanged,
}: SecretTableProps) {
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SecretSummary | null>(null);
  const [history, setHistory] = useState<SecretSummary | null>(null);
  const [deleting, setDeleting] = useState<SecretSummary | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? [...secrets]
        : secrets.filter((secret) => secret.name.toLowerCase().includes(needle));

    // By code unit rather than `localeCompare`: secret names are ASCII
    // identifiers, and a locale-aware collation would order `API_KEY` and
    // `api_key` differently depending on the reader's browser.
    filtered.sort((a, b) => {
      const order =
        sortKey === 'name'
          ? a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0
          : a.updatedAt < b.updatedAt
            ? -1
            : a.updatedAt > b.updatedAt
              ? 1
              : 0;
      return sortDirection === 'asc' ? order : -order;
    });

    return filtered;
  }, [secrets, query, sortKey, sortDirection]);

  // Selection is tracked by name and intersected with what is on screen, so a
  // row that is filtered out or deleted cannot stay silently selected and be
  // included in the next bulk action.
  const selectedVisible = useMemo(
    () => visible.filter((secret) => selected.has(secret.name)),
    [visible, selected],
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    // Names read best A→Z; timestamps read best newest first. Choosing the
    // useful direction on the first click saves everybody a second one.
    setSortDirection(key === 'name' ? 'asc' : 'desc');
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(visible.map((secret) => secret.name)) : new Set());
  }

  function toggleOne(name: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function deleteOne(name: string) {
    await api.delete(apiPath.secret(orgSlug, projectSlug, envSlug, name));
    setSelected(new Set());
    toast({ variant: 'success', title: `Deleted ${name}` });
    onChanged();
  }

  async function deleteSelected() {
    const names = selectedVisible.map((secret) => secret.name);
    const failed: string[] = [];

    // Sequential, not `Promise.all`. Each delete is a separate audited mutation
    // against the `RL_MUTATION` bucket, and firing forty at once would trip the
    // rate limit and leave a partial deletion nobody asked for. Slower, and the
    // outcome is always describable.
    for (const name of names) {
      try {
        await api.delete(apiPath.secret(orgSlug, projectSlug, envSlug, name));
      } catch {
        // The individual failure is not surfaced: it is one of a batch, and the
        // summary below is what the user needs. Nothing about the thrown value
        // is logged — see the note in `lib/api.ts` about response bodies.
        failed.push(name);
      }
    }

    setSelected(new Set());
    onChanged();

    if (failed.length === 0) {
      toast({ variant: 'success', title: `Deleted ${pluralize(names.length, 'secret')}` });
      return;
    }

    toast({
      variant: 'error',
      title: `${failed.length} of ${names.length} could not be deleted`,
      description: `Still present: ${failed.join(', ')}`,
    });
  }

  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name"
            aria-label="Filter secrets by name"
            autoComplete="off"
            startIcon={<SearchIcon className="size-4" />}
          />
        </div>

        <Button variant="primary" onClick={() => setCreating(true)}>
          New secret
        </Button>
      </div>

      {/* The visible count, and the same fact announced politely. Without this a
          screen reader user who types into the filter hears nothing at all. */}
      <p role="status" aria-live="polite" className="text-fg-subtle text-[0.8125rem]">
        {query.trim().length === 0
          ? `${pluralize(secrets.length, 'secret')}${onLoadMore === null ? '' : ' loaded so far'}`
          : `${visible.length} of ${pluralize(secrets.length, 'secret')} match “${query.trim()}”`}
      </p>

      {selectedVisible.length > 0 ? (
        <div className="border-line bg-canvas-inset flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5">
          <span className="text-fg text-sm font-medium">
            {pluralize(selectedVisible.length, 'secret')} selected
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <span className="flex-1" />
          <Button variant="danger" size="sm" onClick={() => setBulkDeleting(true)}>
            Delete selected
          </Button>
        </div>
      ) : null}

      {actionError !== null ? (
        <Alert tone="danger" title="That action failed">
          <p>{errorMessage(actionError)}</p>
          {isApiError(actionError) && actionError.requestId ? (
            <p className="mt-1.5 text-xs">
              Request id: <code className="font-mono select-all">{actionError.requestId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}

      {secrets.length === 0 ? (
        <EmptyState
          icon={<KeyIcon />}
          title="No secrets in this environment yet"
          description="Add one by hand, or import an existing .env file and have every value in it here in a few seconds."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              New secret
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<SearchIcon />}
          title={`Nothing matches “${query.trim()}”`}
          description="Filtering is on the name only — values are never searched, because searching them would mean decrypting them."
          action={
            <Button variant="secondary" onClick={() => setQuery('')}>
              Clear the filter
            </Button>
          }
        />
      ) : (
        <>
          <TableContainer aria-label={`Secrets in ${envSlug}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pr-0">
                    <Checkbox
                      checked={
                        allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false
                      }
                      onCheckedChange={(checked) => toggleAll(checked === true)}
                      aria-label={
                        allVisibleSelected ? 'Deselect all secrets' : 'Select all secrets shown'
                      }
                    />
                  </TableHead>

                  <SortableHead
                    label="Name"
                    active={sortKey === 'name'}
                    direction={sortDirection}
                    onSort={() => toggleSort('name')}
                  />

                  <TableHead className="w-[38%]">Value</TableHead>
                  <TableHead className="w-20">Version</TableHead>

                  <SortableHead
                    label="Updated"
                    active={sortKey === 'updatedAt'}
                    direction={sortDirection}
                    onSort={() => toggleSort('updatedAt')}
                  />

                  <TableHead className="w-24">Author</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {visible.map((secret) => (
                  <SecretRow
                    key={secret.name}
                    orgSlug={orgSlug}
                    projectSlug={projectSlug}
                    envSlug={envSlug}
                    secret={secret}
                    selected={selected.has(secret.name)}
                    onSelectedChange={(checked) => toggleOne(secret.name, checked)}
                    onEdit={() => setEditing(secret)}
                    onHistory={() => setHistory(secret)}
                    onDelete={() => setDeleting(secret)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {onLoadMore !== null ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={onLoadMore} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}

      <SecretDialog
        orgSlug={orgSlug}
        projectSlug={projectSlug}
        envSlug={envSlug}
        isProduction={isProduction}
        open={creating}
        onOpenChange={setCreating}
        onSaved={onChanged}
      />

      {editing !== null ? (
        <SecretDialog
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          envSlug={envSlug}
          isProduction={isProduction}
          secret={editing}
          open
          onOpenChange={(next) => (next ? undefined : setEditing(null))}
          onSaved={onChanged}
        />
      ) : null}

      {history !== null ? (
        <VersionHistoryDialog
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          envSlug={envSlug}
          isProduction={isProduction}
          secretName={history.name}
          onOpenChange={(next) => (next ? undefined : setHistory(null))}
          onRestored={onChanged}
        />
      ) : null}

      <DeleteSecretConfirm
        secret={deleting}
        isProduction={isProduction}
        onOpenChange={(next) => (next ? undefined : setDeleting(null))}
        onConfirm={async (name) => {
          setActionError(null);
          try {
            await deleteOne(name);
          } catch (cause) {
            setActionError(cause);
            throw cause;
          }
        }}
      />

      <BulkDeleteConfirm
        open={bulkDeleting}
        onOpenChange={setBulkDeleting}
        names={selectedVisible.map((secret) => secret.name)}
        isProduction={isProduction}
        envSlug={envSlug}
        onConfirm={deleteSelected}
      />
    </div>
  );
}

function SortableHead({
  label,
  active,
  direction,
  onSort,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
}) {
  return (
    // `aria-sort` belongs on the header cell, not on the button inside it, and
    // exactly one column may carry a value other than "none".
    <TableHead aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={onSort}
        className="hover:text-fg -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors"
      >
        {label}
        <ChevronUpDownIcon
          aria-hidden="true"
          className={cn('size-3.5', active ? 'text-accent-text' : 'text-fg-subtle')}
        />
      </button>
    </TableHead>
  );
}

function SecretRow({
  orgSlug,
  projectSlug,
  envSlug,
  secret,
  selected,
  onSelectedChange,
  onEdit,
  onHistory,
  onDelete,
}: {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  secret: SecretSummary;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  /**
   * Fetches the plaintext, once per reveal and once per copy.
   *
   * Deliberately not memoised against a cached value: this is the audited
   * endpoint, and every call is meant to produce a `secret.revealed` record. The
   * returned string is handed straight to `SecretValue`, which either renders it
   * behind an auto-remask timer or writes it to the clipboard without rendering
   * it at all. It is never stored here, never logged, and never put in a URL.
   */
  const reveal = useCallback(async () => {
    const response = await api.get<RevealedSecret>(
      apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
    );
    return response.secret.value;
  }, [orgSlug, projectSlug, envSlug, secret.name]);

  return (
    <TableRow className={cn(selected && 'bg-accent-tint/40')}>
      <TableCell className="pr-0 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${secret.name}`}
        />
      </TableCell>

      <TableCell className="align-top">
        <span className="text-fg block font-mono text-[0.8125rem] font-medium break-all">
          {secret.name}
        </span>
        {secret.note ? (
          <span className="text-fg-subtle mt-0.5 block text-xs leading-5">{secret.note}</span>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        <SecretValue name={secret.name} onReveal={reveal} />
      </TableCell>

      <TableCell className="align-top">
        <Badge tone="neutral">v{secret.version}</Badge>
      </TableCell>

      <TableCell className="text-fg-muted align-top text-[0.8125rem] whitespace-nowrap">
        <time dateTime={toIsoString(secret.updatedAt)} title={formatAbsoluteTime(secret.updatedAt)}>
          {formatRelativeTime(secret.updatedAt)}
        </time>
      </TableCell>

      <TableCell className="align-top text-[0.8125rem] whitespace-nowrap">
        <Actor userId={secret.createdBy} />
      </TableCell>

      <TableCell className="align-top">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              // Every row's menu would otherwise be called "Actions", which is
              // useless in a list of sixty.
              aria-label={`Actions for ${secret.name}`}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEdit}>Set a new value…</DropdownMenuItem>
            <DropdownMenuItem onSelect={onHistory}>Version history…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={onDelete}>
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

/**
 * Deleting one secret.
 *
 * In production the confirmation demands the secret's name. That friction is the
 * whole mechanism: a dialog whose button sits under the pointer is a speed bump
 * people learn to clear without reading, and typing a name cannot be satisfied
 * by muscle memory — it forces a comparison between the name in the dialog and
 * the name in the user's head, which is exactly where `STRIPE_KEY_STAGING` and
 * `STRIPE_KEY_PRODUCTION` come apart.
 */
function DeleteSecretConfirm({
  secret,
  isProduction,
  onOpenChange,
  onConfirm,
}: {
  secret: SecretSummary | null;
  isProduction: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  if (secret === null) return null;

  const description =
    'Anything reading this secret keeps working until its next deploy, so a mistake here surfaces late.';

  if (isProduction) {
    return (
      <ConfirmDialog
        strength="production"
        confirmPhrase={secret.name}
        open
        onOpenChange={onOpenChange}
        title={`Delete ${secret.name}?`}
        description={description}
        confirmLabel="Delete secret"
        onConfirm={() => onConfirm(secret.name)}
      >
        <SecretSoftDeleteNote />
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Delete ${secret.name}?`}
      description={description}
      confirmLabel="Delete secret"
      onConfirm={() => onConfirm(secret.name)}
    >
      <SecretSoftDeleteNote />
    </ConfirmDialog>
  );
}

function BulkDeleteConfirm({
  open,
  onOpenChange,
  names,
  isProduction,
  envSlug,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  names: readonly string[];
  isProduction: boolean;
  envSlug: string;
  onConfirm: () => Promise<void>;
}) {
  const title = `Delete ${pluralize(names.length, 'secret')}?`;
  const description =
    'Each one is deleted separately and each is recorded in the audit log. Anything reading them keeps working until its next deploy.';

  const list = (
    <div className="border-line bg-canvas-inset max-h-40 overflow-y-auto rounded-lg border p-3">
      <ul className="text-fg-muted space-y-0.5 font-mono text-xs">
        {names.map((name) => (
          <li key={name} className="break-all">
            {name}
          </li>
        ))}
      </ul>
    </div>
  );

  if (isProduction) {
    return (
      <ConfirmDialog
        // The environment slug rather than a secret name: no single name
        // describes the set, and the environment is the thing whose contents are
        // about to change.
        strength="production"
        confirmPhrase={envSlug}
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        confirmLabel="Delete them"
        onConfirm={onConfirm}
      >
        {list}
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel="Delete them"
      onConfirm={onConfirm}
    >
      {list}
    </ConfirmDialog>
  );
}

function SecretSoftDeleteNote() {
  return (
    <Alert tone="info" title="The versions survive">
      This is a soft delete: the value&apos;s history stays in the database, and the name is
      released immediately, so a secret deleted by mistake can be created again.
    </Alert>
  );
}

/** The table's shape, while the first page is in flight. */
export function SecretTableSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading secrets" className="flex flex-col gap-4">
      <Skeleton className="h-9 w-full sm:max-w-xs" />
      <div className="border-line bg-surface rounded-xl border">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="border-line-subtle flex items-center gap-4 border-b px-3 py-3.5 last:border-b-0"
          >
            <Skeleton className="h-4 w-40 shrink-0" />
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-4 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
