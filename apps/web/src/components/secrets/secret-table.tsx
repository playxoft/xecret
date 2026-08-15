'use client';

import { useMemo, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ChevronUpDownIcon,
  ConfirmDialog,
  EmptyState,
  EyeIcon,
  EyeOffIcon,
  Input,
  KeyIcon,
  LayersIcon,
  PlusIcon,
  PointerIcon,
  SearchIcon,
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
import { BulkAddPanel } from './bulk-add-panel';
import type { EnvironmentTarget } from './multi-environment-write';
import { useRevealAll } from './use-reveal-all';
import type { RevealAll } from './use-reveal-all';
import { DraftRow } from './draft-row';
import { SecretRow } from './secret-row';
import { useStagedChanges } from './staged-changes';
import type { SaveOutcome } from './staged-changes';
import { VersionHistoryDialog } from './version-history-dialog';
import type { SecretSummary } from './types';

export interface SecretTableProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  /** Every environment in this project, so a paste can fan out across them. */
  environments: readonly EnvironmentTarget[];
  secrets: readonly SecretSummary[];
  /** Present when the environment holds more than one page. */
  onLoadMore: (() => void) | null;
  loadingMore: boolean;
  onChanged: () => void;
  /** Opens the import and export dialogs, which the environment screen owns. */
  onImport?: (() => void) | undefined;
  onExport?: (() => void) | undefined;
}

type SortKey = 'name' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

/**
 * The environment's secrets. The main screen of the product.
 *
 * ── An editor, not a viewer with dialogs bolted on ──
 * Adding six keys to a new environment is one task. Doing it through a modal
 * per key makes it six, and the modal is in the way of the only thing that
 * helps — seeing the other five while you type the sixth. So new rows are
 * composed in the table, existing values are rewritten in the table, and one
 * save button commits the lot. `staged-changes.ts` holds that work; this
 * component is the surface it is edited through.
 *
 * Dialogs survive where the task genuinely is modal and rare: version history,
 * import and export of whole documents, and deletion — which is the one action
 * here that cannot be undone by discarding.
 *
 * ── Keyboard and screen reader ──
 * A real `<table>`, so a screen reader announces row and column context as the
 * user moves ("row 4 of 60, Name, DATABASE_URL"). Sortable columns are buttons
 * inside their `<th>` and the `<th>` carries `aria-sort`, which is the only part
 * a screen reader reads — the arrow glyph is decorative. Every per-row control
 * names its row ("Reveal the value of DATABASE_URL"), because "Reveal" repeated
 * sixty times is unusable. Filtering announces its result count through a polite
 * live region rather than silently changing the number of rows under the cursor,
 * and so does the count of unsaved changes.
 */
export function SecretTable({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  environments,
  secrets,
  onLoadMore,
  loadingMore,
  onChanged,
  onImport,
  onExport,
}: SecretTableProps) {
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [bulkAdding, setBulkAdding] = useState(false);
  const revealAll = useRevealAll(orgSlug, projectSlug, envSlug);
  const [hoverReveal, setHoverReveal] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [history, setHistory] = useState<SecretSummary | null>(null);
  const [deleting, setDeleting] = useState<SecretSummary | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const staged = useStagedChanges(orgSlug, projectSlug, envSlug);

  const existingNames = useMemo(() => new Set(secrets.map((secret) => secret.name)), [secrets]);

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

  /**
   * Whether hover mode can actually show anything.
   *
   * Derived rather than stored, so the window ending, a failed decryption and a
   * change of environment all put the toggle out on their own — a button that
   * stays lit while doing nothing is the worse of the two failures. Re-arming it
   * is one click and is the user's decision to make: renewing the decryption
   * every three minutes on its own would hold an environment in memory for as
   * long as the tab stayed open, which is the thing the window exists to stop.
   */
  const hoverArmed = hoverReveal && revealAll.values !== null;

  /**
   * Hover mode runs on the same single decryption "Reveal all" uses, which is
   * why turning it on loads without showing anything: the alternative — each row
   * fetching itself as the pointer crosses it — would decrypt an environment one
   * credential at a time and write an audit record per mouse movement.
   */
  function toggleHoverReveal() {
    setHovered(null);
    if (hoverArmed) {
      setHoverReveal(false);
      return;
    }
    setHoverReveal(true);
    revealAll.load();
  }

  /** The plaintext this row should show, if it should be showing one at all. */
  function shownValue(name: string): string | undefined {
    const plaintext = revealAll.values?.[name];
    if (plaintext === undefined) return undefined;
    if (revealAll.revealed) return plaintext;
    return hoverArmed && hovered === name ? plaintext : undefined;
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
    // A staged rewrite of a secret that no longer exists would fail on the next
    // save with a 404 nobody could explain.
    staged.closeEdit(name);
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
        staged.closeEdit(name);
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

  async function saveStaged() {
    if (staged.pendingCount === 0 || staged.saving) return;
    setActionError(null);

    const outcome = await staged.save(existingNames);
    // Always, even on a total failure: a partial batch has already changed the
    // environment, and leaving the table showing the old versions would make
    // the next save operate on stale version numbers.
    onChanged();
    announce(outcome);
  }

  function announce(outcome: SaveOutcome) {
    const wrote = outcome.created + outcome.updated;
    const parts: string[] = [];
    if (outcome.created > 0) parts.push(`${pluralize(outcome.created, 'secret')} created`);
    if (outcome.updated > 0) parts.push(`${outcome.updated} updated`);
    if (outcome.unchanged > 0) parts.push(`${outcome.unchanged} already had that value`);

    if (outcome.failed === 0) {
      toast({
        variant: wrote === 0 ? 'info' : 'success',
        title: wrote === 0 ? 'Nothing to save' : 'Saved',
        ...(parts.length > 0 ? { description: `${parts.join(', ')}.` } : {}),
      });
      return;
    }

    toast({
      variant: 'error',
      title: `${pluralize(outcome.failed, 'row')} could not be saved`,
      description:
        parts.length > 0
          ? `${parts.join(', ')}. The rows that failed are still in the table with the reason.`
          : 'They are still in the table, each with the reason.',
    });
  }

  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;
  const hasRows = visible.length > 0 || staged.drafts.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        query={query}
        onQueryChange={setQuery}
        bulkAdding={bulkAdding}
        onToggleBulkAdd={() => setBulkAdding((current) => !current)}
        onAddDraft={() => staged.addDraft()}
        disabled={staged.saving}
        revealAll={revealAll}
        hoverReveal={hoverArmed}
        hoverLoading={hoverReveal && revealAll.loading}
        onToggleHoverReveal={toggleHoverReveal}
        hasSecrets={secrets.length > 0}
        {...(onImport === undefined ? {} : { onImport })}
        {...(onExport === undefined ? {} : { onExport })}
      />

      {bulkAdding ? (
        <BulkAddPanel
          onAdd={staged.addDrafts}
          onClose={() => setBulkAdding(false)}
          currentEnvSlug={envSlug}
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          environments={environments}
          onWritten={onChanged}
        />
      ) : null}

      {/* The visible count, and the same fact announced politely. Without this a
          screen reader user who types into the filter hears nothing at all. */}
      <p role="status" aria-live="polite" className="text-fg-subtle text-sm">
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

      {revealAll.error !== null ? (
        // Both reveal controls run on the one decryption, so both fail through
        // here. Without this a failed "Reveal all" was a button that spun and
        // then did nothing, with no way to tell a permission error in production
        // apart from a dropped connection.
        <Alert tone="danger" title="Could not reveal these values">
          <p>{revealAll.error}</p>
        </Alert>
      ) : null}

      {actionError !== null ? (
        <Alert tone="danger" title="That action failed">
          <p>{errorMessage(actionError)}</p>
          {isApiError(actionError) && actionError.requestId ? (
            <p className="mt-1.5 text-sm">
              Request id: <code className="font-mono select-all">{actionError.requestId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}

      {!hasRows && secrets.length === 0 ? (
        <EmptyState
          icon={<KeyIcon />}
          title="No secrets in this environment yet"
          description="Add one here, paste a whole block of them, or import an existing .env file and have every value in it here in a few seconds."
          action={
            <Button variant="primary" onClick={() => staged.addDraft()}>
              <PlusIcon className="size-4" />
              Add a secret
            </Button>
          }
          secondaryAction={
            <Button variant="secondary" onClick={() => setBulkAdding(true)}>
              <LayersIcon className="size-4" />
              Paste several
            </Button>
          }
        />
      ) : !hasRows ? (
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
                      disabled={visible.length === 0}
                    />
                  </TableHead>

                  <SortableHead
                    label="Name"
                    active={sortKey === 'name'}
                    direction={sortDirection}
                    onSort={() => toggleSort('name')}
                  />

                  <TableHead className="w-[34%]">Value</TableHead>
                  <TableHead className="w-24">Type</TableHead>
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
                {visible.map((secret) => {
                  const plaintext = shownValue(secret.name);
                  return (
                    <SecretRow
                      key={secret.name}
                      orgSlug={orgSlug}
                      projectSlug={projectSlug}
                      envSlug={envSlug}
                      secret={secret}
                      selected={selected.has(secret.name)}
                      edit={staged.edits.get(secret.name)}
                      existingNames={existingNames}
                      disabled={staged.saving}
                      {...(plaintext === undefined ? {} : { revealed: plaintext })}
                      {...(hoverArmed
                        ? {
                            onHoverChange: (hovering: boolean) =>
                              setHovered((current) =>
                                hovering ? secret.name : current === secret.name ? null : current,
                              ),
                          }
                        : {})}
                      onSelectedChange={(checked) => toggleOne(secret.name, checked)}
                      onEditOpen={() => staged.openEdit(secret.name)}
                      onEditChange={(value) => staged.setEdit(secret.name, value)}
                      onMetaChange={(patch) => staged.setEditMeta(secret.name, patch)}
                      onEditClose={() => staged.closeEdit(secret.name)}
                      onTypeChange={(type) => staged.setEditType(secret.name, type)}
                      onHistory={() => setHistory(secret)}
                      onDelete={() => setDeleting(secret)}
                      onCommit={saveStaged}
                    />
                  );
                })}

                {/* Drafts sit at the bottom, below whatever the sort and filter
                    are doing, because a row being typed into must not move when
                    its name crosses an alphabetical boundary mid-keystroke. */}
                {staged.drafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    draft={draft}
                    drafts={staged.drafts}
                    existingNames={existingNames}
                    disabled={staged.saving}
                    onPatch={(patch) => staged.patchDraft(draft.id, patch)}
                    onExpand={(seeds) => staged.expandDraft(draft.id, seeds)}
                    onRemove={() => staged.removeDraft(draft.id)}
                    onCommit={saveStaged}
                  />
                ))}

                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-fg-muted w-full justify-start"
                      disabled={staged.saving}
                      onClick={() => staged.addDraft()}
                    >
                      <PlusIcon className="size-4" />
                      Add a secret
                    </Button>
                  </TableCell>
                </TableRow>
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

      <SaveBar
        count={staged.pendingCount}
        saving={staged.saving}
        isProduction={isProduction}
        onDiscard={staged.discardAll}
        onSave={saveStaged}
      />

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
        // Recorded here *and* rethrown. The rethrow keeps `ConfirmDialog` open
        // with the message beside the button that failed, which is where a
        // person is looking; the copy kept here is what survives dismissal, and
        // it is the one carrying the request id a support ticket needs.
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

function Toolbar({
  query,
  onQueryChange,
  bulkAdding,
  onToggleBulkAdd,
  onAddDraft,
  disabled,
  revealAll,
  hoverReveal,
  hoverLoading,
  onToggleHoverReveal,
  hasSecrets,
  onImport,
  onExport,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  bulkAdding: boolean;
  onToggleBulkAdd: () => void;
  onAddDraft: () => void;
  disabled: boolean;
  revealAll: RevealAll;
  hoverReveal: boolean;
  hoverLoading: boolean;
  onToggleHoverReveal: () => void;
  hasSecrets: boolean;
  onImport?: () => void;
  onExport?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 sm:max-w-xs">
        <Input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter by name"
          aria-label="Filter secrets by name"
          autoComplete="off"
          startIcon={<SearchIcon className="size-4" />}
        />
      </div>

      <span className="hidden flex-1 sm:block" />

      {hasSecrets ? (
        <>
          <Button
            variant={revealAll.revealed ? 'secondary' : 'ghost'}
            onClick={revealAll.revealed ? revealAll.hide : revealAll.reveal}
            loading={revealAll.loading && !hoverLoading}
            aria-pressed={revealAll.revealed}
          >
            {revealAll.revealed ? (
              <EyeOffIcon className="size-4" />
            ) : (
              <EyeIcon className="size-4" />
            )}
            {revealAll.revealed ? 'Hide all' : 'Reveal all'}
          </Button>

          {/* Between the two extremes this screen otherwise offers: one value at
              a time behind a click, or the whole environment on screen at once.
              Comparing eight rows against a `.env` file wants neither — it wants
              the value under the pointer and nothing else, which is also the
              smallest thing a screenshot can catch. */}
          <Button
            variant={hoverReveal ? 'secondary' : 'ghost'}
            onClick={onToggleHoverReveal}
            loading={hoverLoading}
            aria-pressed={hoverReveal}
            title="Show each value while the pointer is over its row"
          >
            <PointerIcon className="size-4" />
            Reveal on hover
          </Button>
        </>
      ) : null}

      {onImport ? (
        <Button variant="ghost" onClick={onImport}>
          Import
        </Button>
      ) : null}
      {onExport ? (
        <Button variant="ghost" onClick={onExport}>
          Export
        </Button>
      ) : null}

      <Button
        variant="secondary"
        onClick={onToggleBulkAdd}
        aria-expanded={bulkAdding}
        disabled={disabled}
      >
        <LayersIcon className="size-4" />
        Bulk add
      </Button>

      <Button variant="primary" onClick={onAddDraft} disabled={disabled}>
        <PlusIcon className="size-4" />
        Add secret
      </Button>
    </div>
  );
}

/**
 * The unsaved-work bar.
 *
 * Sticky to the bottom of the viewport rather than pinned under the table: with
 * sixty rows the save button would otherwise be a scroll away from the row being
 * edited, and "I pressed save" / "no you didn't" is the failure mode that
 * follows.
 *
 * In production it is marked with the production tone, which is the one thing in
 * the design system that colour is reserved for. There is no typed confirmation
 * phrase here, deliberately: a write in production is recoverable — the previous
 * version stays in the history and can be restored in two clicks — and the same
 * write through the old dialog was not gated either. Deletion is where the typed
 * phrase belongs, and that is where it still is.
 */
function SaveBar({
  count,
  saving,
  isProduction,
  onDiscard,
  onSave,
}: {
  count: number;
  saving: boolean;
  isProduction: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="sticky bottom-4 z-20">
      <div
        className={cn(
          'bg-surface shadow-overlay mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
          isProduction ? 'border-production-line' : 'border-line-strong',
        )}
      >
        {isProduction ? <Badge tone="production">Production</Badge> : null}

        <p role="status" aria-live="polite" className="text-fg text-sm font-medium">
          {pluralize(count, 'unsaved change')}
        </p>

        <p className="text-fg-subtle hidden text-sm sm:block">
          {isProduction
            ? 'Whatever reads these secrets picks the new values up on its next deploy, not immediately.'
            : 'Each row is written separately and recorded in the audit log.'}
        </p>

        <span className="flex-1" />

        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving}>
          {isProduction ? 'Save to production' : 'Save changes'}
        </Button>
      </div>
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
      <ul className="text-fg-muted space-y-0.5 font-mono text-sm">
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
