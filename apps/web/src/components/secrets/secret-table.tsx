'use client';

import { useEffect, useMemo, useState } from 'react';

import { toSecretValueType } from '@xecret/core/validation';
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
  ColumnsIcon,
  ConfirmDialog,
  DownloadIcon,
  EmptyState,
  EyeIcon,
  EyeOffIcon,
  Input,
  KeyIcon,
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
  UnsavedChangesGuard,
  UploadIcon,
  useToast,
} from '@/components/ui';
import type { EnvironmentTarget } from './environment-target';
import { useComparedSecrets } from './use-compared-secrets';
import { usePlaintextCache } from './use-plaintext-cache';
import { REVEAL_DURATION_MS, useRevealAll } from './use-reveal-all';
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
  /**
   * Every environment in this project — read for `isProduction`, which decides
   * which writes are confirmed, and to name the one on screen.
   */
  environments: readonly EnvironmentTarget[];
  /**
   * The environments shift-clicked in the switcher, shown beside this one's
   * values. Empty is the normal case and costs nothing.
   */
  comparedEnvironments: readonly EnvironmentTarget[];
  /** Drops every compared environment — the "stop comparing" button. */
  onStopComparing: () => void;
  secrets: readonly SecretSummary[];
  /**
   * Bumped by every write to this environment that happens outside this
   * component — an import, today.
   *
   * The table holds a decrypted snapshot of the environment behind "Reveal all",
   * and a write it cannot see makes that snapshot a set of superseded
   * credentials: displayed, copied to the clipboard, and seeded into the next
   * edit, which then writes them back over what the import just landed. The
   * dialogs that do those writes are owned by the screen above, so this is how
   * they say so.
   */
  externalWrites: number;
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
  comparedEnvironments,
  onStopComparing,
  externalWrites,
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

  const revealAll = useRevealAll(orgSlug, projectSlug, envSlug);
  /**
   * The per-row decryptions, held above the rows so they survive a row
   * unmounting — which is what a filter keystroke does to fifty of them.
   */
  const plaintexts = usePlaintextCache(`${orgSlug}/${projectSlug}/${envSlug}`);
  const [hoverReveal, setHoverReveal] = useState(false);
  /**
   * The rows hover mode has shown so far.
   *
   * A set that only grows, so a value stays on screen once the pointer has
   * brought it up. Hiding it again the moment the pointer moved on made the mode
   * useless for the thing it exists for — reading one value while typing it
   * somewhere else — and turned a table into something that had to be re-hovered
   * to be re-read. Turning the mode off empties it.
   */
  const [hoverRevealed, setHoverRevealed] = useState<ReadonlySet<string>>(new Set());
  // Which environment's history: a compared row's version chip opens the
  // history of *that* environment, not of the one the page is about.
  const [history, setHistory] = useState<{ envSlug: string; secretName: string } | null>(null);
  const [deleting, setDeleting] = useState<SecretSummary | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const staged = useStagedChanges(orgSlug, projectSlug, envSlug);
  const compared = useComparedSecrets(orgSlug, projectSlug, comparedEnvironments);

  // Compared during render rather than in an effect: an effect runs after paint,
  // so the superseded value would be on screen for a frame — and could be
  // clicked into an editor in that frame.
  const [renderedWrites, setRenderedWrites] = useState(externalWrites);
  if (renderedWrites !== externalWrites) {
    setRenderedWrites(externalWrites);
    forgetDecrypted();
  }

  /**
   * Drops every decrypted value the page is holding — the whole-environment
   * snapshot behind "Reveal all" and the per-row cache alike.
   *
   * The two are one fact and are forgotten together: a write that left either
   * behind would leave the table showing a credential that has just been
   * replaced, put it on the clipboard, and seed it into the next edit — which
   * would write it back over what was saved. A function declaration rather than
   * a `const`, because the render-phase call above runs before this line.
   */
  function forgetDecrypted() {
    revealAll.forget();
    // The other place this screen holds plaintext for the environment that has
    // just been written behind its back. An import that overwrites a key whose
    // editor is open leaves that editor displaying the pre-import value as
    // though it were the stored one — and amending a character of it and saving
    // would write it back, silently reverting the import. Nothing here takes
    // what the user typed; only the seed it was typed over.
    staged.forgetSeeds();
    plaintexts.forget();
  }

  const currentEnvironment = environments.find((entry) => entry.slug === envSlug);

  /** Whether a given environment is the production one, for the dialogs. */
  function environmentIsProduction(slug: string): boolean {
    if (slug === envSlug) return isProduction;
    return environments.find((entry) => entry.slug === slug)?.isProduction ?? false;
  }

  // Hiding the tab masks the rows hover mode has stuck open, exactly as it
  // masks everything else on screen. `useRevealAll` cannot do this one: in hover
  // mode its values arrive through `load()`, which never sets `shown`, so its
  // own visibility listener is not even registered. Starting a screen share must
  // not leave three plaintexts rendered because the pointer once passed over
  // them.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setHoverRevealed(new Set());
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // And the window masks them, on the same clock as everything else — counted
  // from the decryption, exactly as it is counted there. `useRevealAll` used to
  // do this by dropping its values outright when the window ended; now that it
  // keeps them — masking and forgetting being different acts — a row the pointer
  // once crossed would otherwise stay on screen for the rest of the session.
  useEffect(() => {
    if (revealAll.values === null) return;

    const maskAt = setTimeout(() => setHoverRevealed(new Set()), REVEAL_DURATION_MS);
    return () => clearTimeout(maskAt);
  }, [revealAll.values]);

  const existingNames = useMemo(() => new Set(secrets.map((secret) => secret.name)), [secrets]);

  /**
   * How many keys each compared environment holds that this one does not.
   *
   * Compared values are rendered inside *this* environment's rows, so a key that
   * exists only in staging has nowhere to appear. Counting them is the
   * difference between a comparison that is silently partial and one that says
   * what it cannot show — and "staging has three keys production does not" is
   * usually the answer somebody opened this screen to find.
   */
  const comparedOnly = useMemo(
    () =>
      // Only once *this* environment is fully loaded. `existingNames` covers the
      // pages fetched so far, so with a "Load more" still on screen every key
      // past the boundary counts as one this environment "does not have" — the
      // banner asserting an absence that is really just a horizon, and the count
      // changing when the user pages in the rest without anything being written.
      // `ComparedEnvironment.truncated` is the same admission from the other
      // side, and this is a secrets manager: "production does not have this" is
      // exactly the wrong answer that ends in an outage.
      onLoadMore !== null
        ? []
        : compared.environments
            .map((environment) => ({
              name: environment.name,
              count: [...environment.byName.keys()].filter((name) => !existingNames.has(name))
                .length,
            }))
            .filter((entry) => entry.count > 0),
    [compared.environments, existingNames, onLoadMore],
  );

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
  /**
   * Masks everything, including the rows hover mode has stuck open.
   *
   * "Hide all" used to leave those on screen — and their own eye buttons are
   * disabled while a value is supplied from here, so there was no control left
   * that could mask them.
   */
  function hideAll() {
    revealAll.hide();
    setHoverRevealed(new Set());
  }

  function toggleHoverReveal() {
    setHoverRevealed(new Set());
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
    return hoverArmed && hoverRevealed.has(name) ? plaintext : undefined;
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
    // The snapshot "Reveal all" is holding describes an environment that no
    // longer exists. See `RevealAll.forget` for what a stale one does.
    forgetDecrypted();
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
    forgetDecrypted();
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
    // environment, and leaving the table showing the old versions would make the
    // next save operate on stale version numbers.
    onChanged();
    // The decrypted snapshot goes with them, but only if something was actually
    // written — a row that kept showing the value it had before the save would
    // seed the *next* edit from it and write it back over what was just saved.
    // A batch that failed validation wrote nothing, and un-revealing the whole
    // environment over it would cost a fresh decryption for no reason.
    //
    // `wrote` rather than `created || updated`: a row writes its value and its
    // metadata as two requests, so a rename rejected after the value has landed
    // counts only as `failed` while having changed the environment all the same.
    if (outcome.wrote) forgetDecrypted();
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

  const startDrafts = staged.drafts.filter((draft) => draft.placement === 'start');
  const endDrafts = staged.drafts.filter((draft) => draft.placement !== 'start');

  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected;
  const hasRows = visible.length > 0 || staged.drafts.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        query={query}
        onQueryChange={setQuery}
        // From the top of the table, so the new row lands where the button that
        // made it is. The one under the last row appends instead.
        onAddDraft={() => staged.addDraft(undefined, 'start')}
        disabled={staged.saving}
        revealAll={revealAll}
        onHideAll={hideAll}
        hoverReveal={hoverArmed}
        hoverLoading={hoverReveal && revealAll.loading}
        onToggleHoverReveal={toggleHoverReveal}
        hasSecrets={secrets.length > 0}
        {...(onImport === undefined ? {} : { onImport })}
        {...(onExport === undefined ? {} : { onExport })}
      />

      {comparedEnvironments.length > 0 ? (
        <div className="border-line bg-canvas-inset flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5">
          <ColumnsIcon aria-hidden="true" className="text-fg-subtle size-4" />
          <p role="status" aria-live="polite" className="text-fg text-sm font-medium">
            Comparing {comparedEnvironments.map((environment) => environment.name).join(', ')}
          </p>
          <p className="text-fg-subtle hidden text-sm sm:block">
            {comparedOnly.length > 0
              ? comparedOnly
                  .map(
                    (entry) =>
                      `${entry.name} has ${pluralize(entry.count, 'key')} this environment does not, not shown here.`,
                  )
                  .join(' ')
              : 'Their values are masked until you ask for one, exactly like this environment’s. Editing one there saves to that environment on its own.'}
          </p>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onStopComparing}>
            Stop comparing
          </Button>
        </div>
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
          description="Add one here, or import an existing .env file and have every value in it here in a few seconds."
          action={
            <Button variant="primary" onClick={() => staged.addDraft()}>
              <PlusIcon className="size-4" />
              Add a secret
            </Button>
          }
          {...(onImport === undefined
            ? {}
            : {
                secondaryAction: (
                  <Button variant="secondary" onClick={onImport}>
                    <UploadIcon className="size-4" />
                    Import a file
                  </Button>
                ),
              })}
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
            {/* `table-fixed`, so the columns are the widths declared in the
                header and nothing in a cell can argue with them.

                Under the browser's automatic layout every column is as wide as
                its widest cell wants to be — which meant that revealing a value
                re-measured the whole table. "Reveal all" on an environment
                holding one long connection string squeezed the key column to
                make room for it and moved every key on screen sideways; masking
                put it all back. The value field can only be a constant width if
                the column it sits in is, and that is decided here rather than in
                the field. */}
            <Table className="table-fixed">
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
                    label="Key"
                    active={sortKey === 'name'}
                    direction={sortDirection}
                    onSort={() => toggleSort('name')}
                    className="w-[30%] min-w-56"
                  />

                  {/* Two columns, so the value gets every pixel the table can
                      give it. Sorting by "updated" lost its column with the
                      timestamp and keeps its control here: a table you cannot
                      order by recency is a table you cannot audit. */}
                  {/* No `aria-sort` here: it belongs to the column it describes,
                      and this control orders the table by a timestamp that no
                      longer has a column. Announcing "Value, sorted descending"
                      would be a plain misstatement, so the button carries its own
                      state instead. It sits beside the label rather than at the
                      far end of a very wide header, where it read as belonging to
                      whatever was underneath it. */}
                  <TableHead>
                    <span className="flex items-center gap-3">
                      Value
                      <SortButton
                        label="Recently updated"
                        active={sortKey === 'updatedAt'}
                        direction={sortDirection}
                        onSort={() => toggleSort('updatedAt')}
                        pressed={sortKey === 'updatedAt'}
                      />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {/* Rows added from the toolbar sit above everything, in the
                    order they were added. A row being typed into must not move,
                    so drafts never take part in the sort or the filter. */}
                {startDrafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    draft={draft}
                    drafts={staged.drafts}
                    existingNames={existingNames}
                    disabled={staged.saving}
                    onPatch={(patch) => staged.patchDraft(draft.id, patch)}
                    onExpand={(seeds) => staged.expandDraft(draft.id, seeds)}
                    onRemove={() => staged.removeDraft(draft.id)}
                    onAddNext={() => staged.addDraft(undefined, draft.placement)}
                    onCommit={saveStaged}
                  />
                ))}

                {visible.map((secret) => {
                  const plaintext = shownValue(secret.name);
                  return (
                    <SecretRow
                      key={secret.name}
                      orgSlug={orgSlug}
                      projectSlug={projectSlug}
                      envSlug={envSlug}
                      environment={currentEnvironment}
                      secret={secret}
                      selected={selected.has(secret.name)}
                      edit={staged.edits.get(secret.name)}
                      existingNames={existingNames}
                      disabled={staged.saving}
                      plaintexts={plaintexts}
                      compare={compared.environments}
                      {...(plaintext === undefined ? {} : { revealed: plaintext })}
                      {...(hoverArmed
                        ? {
                            // Only the arrival is interesting. Leaving used to
                            // hide the value again, which is the behaviour this
                            // set exists to undo.
                            onHoverChange: (hovering: boolean) => {
                              if (!hovering) return;
                              setHoverRevealed((current) =>
                                current.has(secret.name)
                                  ? current
                                  : new Set(current).add(secret.name),
                              );
                            },
                          }
                        : {})}
                      onSelectedChange={(checked) => toggleOne(secret.name, checked)}
                      onEditOpen={() => staged.openEdit(secret.name)}
                      onEditSeed={(value) => staged.seedEdit(secret.name, value)}
                      onEditChange={(value) => staged.setEdit(secret.name, value)}
                      onEditCancel={() => staged.resetEditValue(secret.name)}
                      onMetaChange={(patch) => staged.setEditMeta(secret.name, patch)}
                      // Radix fires this for the item that is already checked,
                      // so re-picking a secret's own type has to un-stage rather
                      // than stage a change to nothing — which would otherwise
                      // save as a real write against a secret nobody altered.
                      onTypeChange={(type) =>
                        type === toSecretValueType(secret.valueType)
                          ? staged.clearEditType(secret.name)
                          : staged.setEditType(secret.name, type)
                      }
                      onHistory={(slug) => setHistory({ envSlug: slug, secretName: secret.name })}
                      onDelete={() => setDeleting(secret)}
                      onCommit={saveStaged}
                      onComparedSaved={compared.reload}
                    />
                  );
                })}

                {/* And rows added from the button below the table stay below it,
                    for the same reason: the row appears where the click was. */}
                {endDrafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    draft={draft}
                    drafts={staged.drafts}
                    existingNames={existingNames}
                    disabled={staged.saving}
                    onPatch={(patch) => staged.patchDraft(draft.id, patch)}
                    onExpand={(seeds) => staged.expandDraft(draft.id, seeds)}
                    onRemove={() => staged.removeDraft(draft.id)}
                    onAddNext={() => staged.addDraft(undefined, draft.placement)}
                    onCommit={saveStaged}
                  />
                ))}

                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={3} className="py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-fg-muted w-full justify-start"
                      disabled={staged.saving}
                      onClick={() => staged.addDraft(undefined, 'end')}
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

      {/* Nothing in this table is written until Save is pressed, and the table
          is reached by clicking through a sidebar full of other environments.
          Losing an afternoon's worth of staged rotations to a misplaced click is
          the one mistake this screen makes easy, and it is not recoverable —
          there is nothing on the server to go back to. */}
      <UnsavedChangesGuard
        when={staged.pendingCount > 0}
        description={`${pluralize(staged.pendingCount, 'change')} to ${envSlug} ${
          staged.pendingCount === 1 ? 'has' : 'have'
        } not been saved.`}
      />

      {history !== null ? (
        <VersionHistoryDialog
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          envSlug={history.envSlug}
          isProduction={environmentIsProduction(history.envSlug)}
          secretName={history.secretName}
          onOpenChange={(next) => (next ? undefined : setHistory(null))}
          // A restore in a compared environment changes that environment's
          // listing, not this one's.
          onRestored={() => {
            if (history.envSlug !== envSlug) {
              compared.reload();
              return;
            }
            forgetDecrypted();
            onChanged();
          }}
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
  onAddDraft,
  disabled,
  revealAll,
  onHideAll,
  hoverReveal,
  hoverLoading,
  onToggleHoverReveal,
  hasSecrets,
  onImport,
  onExport,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onAddDraft: () => void;
  disabled: boolean;
  revealAll: RevealAll;
  /** Masks the "Reveal all" set *and* the rows hover mode has stuck open. */
  onHideAll: () => void;
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

      {/* One group, because these four are one subject: what happens to this
          environment's values as a set. Reveal them, reveal them under the
          pointer, bring a file in, take a file out. Separately they read as
          four unrelated buttons competing with "Add secret", which is the only
          thing on this bar about a single key. */}
      <div className="border-line bg-canvas-inset flex flex-wrap items-center gap-0.5 rounded-lg border p-0.5">
        {hasSecrets ? (
          <>
            <Button
              variant={revealAll.revealed ? 'secondary' : 'ghost'}
              size="sm"
              onClick={revealAll.revealed ? onHideAll : revealAll.reveal}
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
              size="sm"
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
          <Button variant="ghost" size="sm" onClick={onImport}>
            <UploadIcon className="size-4" />
            Import
          </Button>
        ) : null}
        {onExport ? (
          <Button variant="ghost" size="sm" onClick={onExport}>
            <DownloadIcon className="size-4" />
            Export
          </Button>
        ) : null}
      </div>

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
  className,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  className?: string;
}) {
  return (
    // `aria-sort` belongs on the header cell, not on the button inside it, and
    // exactly one column may carry a value other than "none".
    <TableHead
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <SortButton label={label} active={active} direction={direction} onSort={onSort} />
    </TableHead>
  );
}

/**
 * The control half of a sortable header.
 *
 * Separated from the `<th>` because one of the two sorts no longer has a column
 * of its own: "updated" lost its timestamp column to the value field and its
 * button now lives inside the value header. `aria-sort` stays on whichever
 * `<th>` the sort is *about*, which is the part a screen reader reads.
 */
function SortButton({
  label,
  active,
  direction,
  onSort,
  pressed,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  /**
   * Set only where the button is not inside the `<th>` it sorts. Where it is,
   * `aria-sort` on that header is the mechanism a screen reader reads, and a
   * pressed state beside it would say the same thing twice.
   */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSort}
      aria-pressed={pressed}
      // The glyph is decorative and `aria-sort` on the `<th>` is what a screen
      // reader reads; this is the sighted equivalent of the same fact.
      title={
        active
          ? `Sorted by ${label.toLowerCase()}, ${direction === 'asc' ? 'ascending' : 'descending'}. Click to reverse.`
          : `Sort by ${label.toLowerCase()}`
      }
      className={cn(
        '-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors',
        active ? 'text-fg' : 'hover:text-fg',
      )}
    >
      {label}
      <ChevronUpDownIcon
        aria-hidden="true"
        className={cn('size-3.5', active ? 'text-accent-text' : 'text-fg-subtle')}
      />
    </button>
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
        {/* Two blocks, because the table has two columns: a key and a value
            field that takes the rest of the width. A third block here would
            promise a column that is not coming. */}
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="border-line-subtle flex items-center gap-4 border-b px-3 py-3.5 last:border-b-0"
          >
            <Skeleton className="h-5 w-40 shrink-0" />
            <Skeleton className="h-9 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
