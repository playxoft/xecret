'use client';

import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';

import {
  checkSecretName,
  checkSecretValue,
  SECRET_NAME_MAX_LENGTH,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  PencilIcon,
  SecretValue,
  Spinner,
  TableCell,
  TableRow,
  Textarea,
  TrashIcon,
} from '@/components/ui';
import { Actor } from './actor';
import type { PendingEdit } from './staged-changes';
import type { RevealedSecret, SecretSummary } from './types';
import { ValueTypeMenu } from './value-type-menu';

const NOTE_MAX_LENGTH = 1024;

/** Whether closing this editor would discard something the user staged. */
function holdsWork(edit: PendingEdit): boolean {
  return (
    edit.value.length > 0 ||
    edit.valueType !== undefined ||
    edit.name !== undefined ||
    edit.note !== undefined
  );
}

export interface SecretRowProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  secret: SecretSummary;
  selected: boolean;
  /** Present while this row is being edited. */
  edit: PendingEdit | undefined;
  /** Every live name in the environment, so a staged rename can be checked as it is typed. */
  existingNames: ReadonlySet<string>;
  disabled: boolean;
  /** Plaintext held by a "Reveal all", which this row displays instead of a mask. */
  revealed?: string | undefined;
  /**
   * Reports the pointer entering and leaving this row, for "Reveal on hover".
   *
   * Passed only while that mode is on: the table re-renders on every change of
   * the hovered row, and sixty rows reporting hovers nobody asked for would do
   * that on every mouse movement across the table.
   */
  onHoverChange?: ((hovering: boolean) => void) | undefined;
  onSelectedChange: (checked: boolean) => void;
  onEditOpen: () => void;
  onEditChange: (value: string) => void;
  /** Stages a rename or a note change; `null` un-stages the field. */
  onMetaChange: (patch: { name?: string | null; note?: string | null }) => void;
  onEditClose: () => void;
  onTypeChange: (type: SecretValueType) => void;
  onHistory: () => void;
  onDelete: () => void;
  /** Ctrl/Cmd+Enter anywhere in the editor commits the whole batch. */
  onCommit: () => void;
}

/**
 * One stored secret.
 *
 * ── Three rules this row exists to hold ──
 *
 *  1. **A stored value is never on screen until somebody asks for it.** The row
 *     renders a fixed-length mask whose length is unrelated to the real one,
 *     because length distinguishes a 16-character API key from a 64-character
 *     token and turns "unknown credential" into "AWS access key,
 *     brute-forceable offline at this cost".
 *  2. **A decryption always goes through the audited endpoint.** The callback
 *     below issues `GET …/secrets/{name}`, which decrypts and writes a
 *     `secret.revealed` record. `SecretValue` holds the result for its reveal
 *     window and re-shows it without asking again, so the record counts
 *     decryptions rather than glances at the screen — see its header for why
 *     that is the honest thing to count.
 *  3. **Copy never renders.** The copy button fetches its own plaintext and
 *     writes it straight to the clipboard; the common case is pasting into a
 *     terminal, and showing it on the way there is exposure that buys nothing.
 *
 * ── Row geometry ──
 * Every cell is `align-middle` and the row carries a minimum height, so the
 * checkbox, the name, the value field, the version chip, the timestamp and the
 * delete button all sit on one optical line. The name and value cells are the
 * two allowed to grow while editing, and they grow downward from a centred
 * baseline.
 *
 * ── Editing in place ──
 * The pencil opens the whole row: the name, the note beneath it, and the value.
 * The value editor opens *empty*, and says so. It is not a text box containing
 * the current value with the cursor at the end, because filling it would mean
 * decrypting a secret because somebody clicked a pencil. Amending rather than
 * retyping is still one click away — "Load current value" runs the same audited
 * reveal as the eye button, and is recorded exactly like one.
 *
 * A rename is metadata, not a rotation: the versions follow the secret's id, so
 * the history survives it. What it breaks is every reader addressing the secret
 * by name — `xecret run`, CI — which the editor says out loud while the rename
 * is staged.
 *
 * ── The row's other two controls ──
 * The version chip is the door to the history drawer — a chip that names a
 * version is the thing a person clicks to ask "what were the others?". And
 * delete is a plain button rather than the last item of a menu: it was the only
 * action left in that menu once editing moved to the pencil and history to the
 * chip, and a menu of one is a click tax.
 */
export function SecretRow({
  orgSlug,
  projectSlug,
  envSlug,
  secret,
  selected,
  edit,
  existingNames,
  disabled,
  revealed,
  onHoverChange,
  onSelectedChange,
  onEditOpen,
  onEditChange,
  onMetaChange,
  onEditClose,
  onTypeChange,
  onHistory,
  onDelete,
  onCommit,
}: SecretRowProps) {
  const reveal = useCallback(async () => {
    const response = await api.get<RevealedSecret>(
      apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
    );
    return response.secret.value;
  }, [orgSlug, projectSlug, envSlug, secret.name]);

  const editing = edit !== undefined;
  const staged = editing && holdsWork(edit);
  const valueType = toSecretValueType(secret.valueType);

  return (
    <TableRow
      // `onFocus`/`onBlur` alongside the pointer events because React maps them
      // to `focusin`/`focusout`, which bubble — so tabbing into any control in
      // the row is the keyboard equivalent of hovering it, and hover mode is not
      // a feature only a mouse can use.
      {...(onHoverChange === undefined
        ? {}
        : {
            onMouseEnter: () => onHoverChange(true),
            onMouseLeave: () => onHoverChange(false),
            onFocus: () => onHoverChange(true),
            onBlur: () => onHoverChange(false),
          })}
      className={cn(
        'h-14',
        staged && 'bg-warning-tint/40 hover:bg-warning-tint/50',
        staged && '[&>td:first-child]:border-l-warning [&>td:first-child]:border-l-2',
        !staged && selected && 'bg-accent-tint/40',
      )}
    >
      <TableCell className="pr-0 align-middle">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${secret.name}`}
        />
      </TableCell>

      <TableCell className="align-middle">
        {editing ? (
          <NameEditor
            secret={secret}
            edit={edit}
            existingNames={existingNames}
            disabled={disabled}
            onMetaChange={onMetaChange}
            onClose={onEditClose}
            onCommit={onCommit}
          />
        ) : (
          <>
            <span className="text-fg block font-mono text-sm font-medium break-all">
              {secret.name}
            </span>
            {secret.note ? (
              <span className="text-fg-subtle mt-0.5 block text-sm leading-5">{secret.note}</span>
            ) : null}
          </>
        )}
        {staged ? (
          <Badge tone="warning" className="mt-1">
            Unsaved
          </Badge>
        ) : null}
      </TableCell>

      <TableCell className="align-middle">
        {editing ? (
          <ValueEditor
            secret={secret}
            valueType={valueType}
            edit={edit}
            disabled={disabled}
            onReveal={reveal}
            onChange={onEditChange}
            onClose={onEditClose}
            onCommit={onCommit}
          />
        ) : (
          <SecretValue
            name={secret.name}
            onReveal={reveal}
            // Handed the plaintext a "Reveal all" already fetched and audited.
            // Without this the button would either re-fetch every row — six
            // audit records for one click — or show nothing.
            {...(revealed === undefined ? {} : { revealed })}
            trailing={
              <Button
                size="icon"
                variant="ghost"
                onClick={onEditOpen}
                disabled={disabled}
                aria-label={`Edit ${secret.name}`}
              >
                <PencilIcon className="size-4" />
              </Button>
            }
          />
        )}
      </TableCell>

      <TableCell className="align-middle">
        <ValueTypeMenu
          value={secret.valueType}
          onChange={onTypeChange}
          disabled={disabled}
          secretName={secret.name}
        />
      </TableCell>

      <TableCell className="align-middle">
        {/* The badge, made a door: the chip that names the current version is
            what a person clicks to ask what the previous ones were. */}
        <button
          type="button"
          onClick={onHistory}
          title={`Version history of ${secret.name}`}
          aria-label={`Version history of ${secret.name}`}
          // No focus utilities: the `:focus-visible` rule in globals.css draws
          // the keyboard ring, same as every button in the product.
          className={cn(
            'border-line bg-canvas-inset text-fg-muted inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium transition-colors',
            'hover:border-accent-line hover:bg-accent-tint hover:text-accent-text',
          )}
        >
          v{secret.version}
        </button>
      </TableCell>

      <TableCell className="text-fg-muted align-middle text-sm whitespace-nowrap">
        <time dateTime={toIsoString(secret.updatedAt)} title={formatAbsoluteTime(secret.updatedAt)}>
          {formatRelativeTime(secret.updatedAt)}
        </time>
      </TableCell>

      <TableCell className="align-middle text-sm whitespace-nowrap">
        <Actor userId={secret.createdBy} serviceTokenId={secret.createdByServiceTokenId} />
      </TableCell>

      <TableCell className="align-middle">
        <Button
          variant="ghost"
          size="icon"
          className="text-fg-muted hover:text-danger-text size-8"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`Delete ${secret.name}`}
        >
          <TrashIcon className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The name and the note, editable, the note directly beneath the title it
 * annotates.
 *
 * A field typed and then restored to the stored text un-stages itself — the
 * comparison happens here, on every keystroke, so `pendingCount` never counts a
 * change that no longer exists.
 */
function NameEditor({
  secret,
  edit,
  existingNames,
  disabled,
  onMetaChange,
  onClose,
  onCommit,
}: {
  secret: SecretSummary;
  edit: PendingEdit;
  existingNames: ReadonlySet<string>;
  disabled: boolean;
  onMetaChange: (patch: { name?: string | null; note?: string | null }) => void;
  onClose: () => void;
  onCommit: () => void;
}) {
  const shownName = edit.name ?? secret.name;
  const shownNote = edit.note ?? secret.note ?? '';
  const rename = edit.name?.trim();
  const wantsRename = rename !== undefined && rename !== secret.name;

  // The same module the server checks against; this copy exists so the failure
  // arrives while the name is under the cursor.
  let nameProblem: string | null = null;
  if (wantsRename) {
    const check = checkSecretName(rename);
    nameProblem = !check.valid
      ? (check.message ?? 'That name cannot be used.')
      : existingNames.has(rename)
        ? 'This environment already has a secret with that name.'
        : null;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
      return;
    }
    // Escape closes an editor holding no work. Once something is staged,
    // Escape would throw away edits — and possibly a pasted credential in the
    // value box beside this one.
    if (event.key === 'Escape' && !holdsWork(edit)) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <Input
        value={shownName}
        onChange={(event) => {
          const next = event.target.value;
          onMetaChange({ name: next === secret.name ? null : next });
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={`Name of ${secret.name}`}
        aria-invalid={nameProblem !== null ? true : undefined}
        maxLength={SECRET_NAME_MAX_LENGTH}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          'h-8 font-mono text-sm',
          nameProblem !== null && 'border-danger focus:border-danger focus:ring-danger/30',
        )}
      />

      {nameProblem !== null ? (
        <p className="text-danger-text text-sm leading-5">{nameProblem}</p>
      ) : wantsRename ? (
        // Said while the rename is staged, not after: the history follows the
        // secret through a rename, but every reader addressing it by name —
        // `xecret run`, CI — stops finding it the moment this is saved.
        <p className="text-warning-text text-sm leading-5">
          Anything reading {secret.name} by name stops finding it.
        </p>
      ) : null}

      <Input
        value={shownNote}
        onChange={(event) => {
          const next = event.target.value;
          onMetaChange({ note: next === (secret.note ?? '') ? null : next });
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="Note (optional)"
        aria-label={`Note for ${secret.name}`}
        maxLength={NOTE_MAX_LENGTH}
        autoComplete="off"
        className="h-8 text-sm"
      />
    </div>
  );
}

function ValueEditor({
  secret,
  valueType,
  edit,
  disabled,
  onReveal,
  onChange,
  onClose,
  onCommit,
}: {
  secret: SecretSummary;
  valueType: SecretValueType;
  edit: PendingEdit;
  disabled: boolean;
  onReveal: () => Promise<string>;
  onChange: (value: string) => void;
  onClose: () => void;
  onCommit: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Checked as you type, against the same module the server checks against on
  // write. This copy exists so the failure arrives while the value is still on
  // screen and fixable; the server's copy is the one that is load-bearing.
  const shape = checkSecretValue(edit.value, valueType);
  const shapeProblem = shape.valid ? null : (shape.message ?? null);

  async function loadCurrent() {
    setLoadError(null);
    setLoading(true);
    try {
      onChange(await onReveal());
      setLoaded(true);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
      return;
    }
    // Escape closes an editor the user has not typed into. Once there is
    // anything staged, Escape would throw away a credential they may have
    // pasted from somewhere they cannot easily get it again.
    if (event.key === 'Escape' && !holdsWork(edit)) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {/* One line high, the same height as every other input in the table. A
          value longer than the box scrolls within it; a taller box would drag
          the row's neighbours out of line for the rare multi-line value. */}
      <Textarea
        value={edit.value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || loading}
        rows={1}
        placeholder={`New value for ${secret.name}`}
        aria-label={`New value for ${secret.name}`}
        aria-invalid={edit.error !== null || shapeProblem !== null ? true : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          'min-h-8 py-1.5 font-mono text-sm leading-5',
          shapeProblem !== null && 'border-danger focus:border-danger focus:ring-danger/30',
        )}
        autoFocus
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg-subtle text-sm">
          Saving a new value appends v{secret.version + 1}. The current one stays in the history.
        </span>

        {loaded ? (
          <span className="text-fg-subtle text-sm">Current value loaded · read recorded</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-sm"
            disabled={disabled || loading}
            onClick={loadCurrent}
          >
            {loading ? <Spinner className="size-3.5" label={null} /> : null}
            Load current value
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-sm"
          disabled={disabled}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>

      {/* The live shape check first: it describes what is in the box now, while
          `edit.error` describes the last save attempt and may already be stale. */}
      {shapeProblem !== null ? (
        <p className="text-danger-text text-sm leading-5">{shapeProblem}</p>
      ) : edit.error !== null ? (
        <p className="text-danger-text text-sm leading-5">{edit.error}</p>
      ) : null}

      {loadError !== null ? (
        <p role="alert" className="text-danger-text text-sm leading-5">
          {loadError}
        </p>
      ) : null}
    </div>
  );
}
