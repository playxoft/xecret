'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import {
  checkSecretName,
  SECRET_NAME_MAX_LENGTH,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { AlertTriangleIcon, Checkbox, Input, TableCell, TableRow, Tooltip } from '@/components/ui';
import { ComparedValue } from './compared-value';
import type { EnvironmentTarget } from './multi-environment-write';
import { hasNewValue, isTouched, wantsRename } from './staged-changes';
import type { PendingEdit } from './staged-changes';
import type { RevealedSecret, SecretSummary } from './types';
import type { ComparedEnvironment } from './use-compared-secrets';
import { ValueField } from './value-field';
import { ValueTypeMenu } from './value-type-menu';

/**
 * Whether this row is holding a change a save would actually write.
 *
 * Asks the same questions `pendingCount` asks, in the same way — a row marked
 * "Unsaved" that Save then skips is a lie the user cannot investigate. In
 * particular a name typed and restored, or given a trailing space, is not a
 * rename.
 */
function holdsWork(storedName: string, edit: PendingEdit): boolean {
  return (
    hasNewValue(edit) ||
    edit.valueType !== undefined ||
    wantsRename(storedName, edit) ||
    edit.note !== undefined
  );
}

export interface SecretRowProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  /** This environment, for the chip a compared row puts beside its value. */
  environment: EnvironmentTarget | undefined;
  secret: SecretSummary;
  selected: boolean;
  /** Present while this row has something staged, or an editor open. */
  edit: PendingEdit | undefined;
  /** Every live name in the environment, so a staged rename can be checked as it is typed. */
  existingNames: ReadonlySet<string>;
  disabled: boolean;
  /** Plaintext held by a "Reveal all", which this row displays instead of a mask. */
  revealed?: string | undefined;
  /** The other environments shift-clicked into this row. Empty is the normal case. */
  compare: readonly ComparedEnvironment[];
  /**
   * Reports the pointer entering and leaving this row, for "Reveal on hover".
   *
   * Passed only while that mode is on: the table re-renders on every change of
   * the hovered row, and sixty rows reporting hovers nobody asked for would do
   * that on every mouse movement across the table.
   */
  onHoverChange?: ((hovering: boolean) => void) | undefined;
  onSelectedChange: (checked: boolean) => void;
  /** Opens the value editor with nothing in it yet. */
  onEditOpen: () => void;
  /** Fills it with the plaintext just revealed, and remembers that as the baseline. */
  onEditSeed: (value: string) => void;
  onEditChange: (value: string) => void;
  /** Drops the staged value, keeping a staged rename, note or type. */
  onEditCancel: () => void;
  /** Stages a rename or a note change; `null` un-stages the field. */
  onMetaChange: (patch: { name?: string | null; note?: string | null }) => void;
  onTypeChange: (type: SecretValueType) => void;
  /** Opens the history drawer for one environment — this one, or a compared one. */
  onHistory: (envSlug: string) => void;
  onDelete: () => void;
  /** Ctrl/Cmd+Enter anywhere in the editor commits the whole batch. */
  onCommit: () => void;
  /** A compared environment was written to, so its listing needs rereading. */
  onComparedSaved: () => void;
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
 *     `secret.revealed` record. That one endpoint answers the eye, the copy
 *     button and the editor alike: opening a value to change one character is a
 *     read of that value, and the audit log is told so.
 *  3. **Copy never renders.** The copy button fetches its own plaintext and
 *     writes it straight to the clipboard; the common case is pasting into a
 *     terminal, and showing it on the way there is exposure that buys nothing.
 *
 * ── Two columns, because there are two things here ──
 * A key and its value. Everything that used to have a column of its own has
 * moved next to whichever of those two it is about: the declared type sits
 * beside the name, because it describes the key; the version, the timestamps,
 * the author and delete sit in the value's hover rail, because they are all
 * facts about the value. What is left is a value field as wide as the table.
 *
 * ── Editing is the default state, not a mode ──
 * The name is an input at all times: clicking it and typing is how it is
 * renamed, with no pencil in between. The value cannot be, because it is not on
 * screen — so clicking the value field fetches it through the audited reveal and
 * hands it to the editor, already filled in. Amending one character of a
 * connection string is then one click, and the audit log records exactly what
 * happened: the value was read.
 *
 * A rename is metadata, not a rotation: the versions follow the secret's id, so
 * the history survives it. What it breaks is every reader addressing the secret
 * by name — `xecret run`, CI — which the row says out loud while the rename is
 * staged.
 */
export function SecretRow({
  orgSlug,
  projectSlug,
  envSlug,
  environment,
  secret,
  selected,
  edit,
  existingNames,
  disabled,
  revealed,
  compare,
  onHoverChange,
  onSelectedChange,
  onEditOpen,
  onEditSeed,
  onEditChange,
  onEditCancel,
  onMetaChange,
  onTypeChange,
  onHistory,
  onDelete,
  onCommit,
  onComparedSaved,
}: SecretRowProps) {
  const [editingValue, setEditingValue] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  /**
   * Which seed request the row is currently waiting for.
   *
   * Bumped by every open and by every cancel, and checked before the result is
   * used. Without it a reveal that was cancelled still lands: `onEditSeed`
   * re-creates the row's staged entry holding a decrypted credential *after*
   * the user closed the editor, where nothing on screen mentions it and no
   * Discard button exists to clear it. And a second open started while the first
   * is still out would have its typed value overwritten when the first replies.
   */
  const seedGeneration = useRef(0);

  const reveal = useCallback(async () => {
    const response = await api.get<RevealedSecret>(
      apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
    );
    return response.secret.value;
  }, [orgSlug, projectSlug, envSlug, secret.name]);

  // A save that succeeded drops this row's staged work, and the editor it was
  // typed into goes with it — otherwise the box stays open over a value that is
  // now simply the stored one. Compared during render rather than in an effect,
  // which is React's documented way to adjust state when a prop changes: an
  // effect runs after paint, so the stale editor would be on screen for a frame.
  if (editingValue && edit === undefined) setEditingValue(false);

  // Anything that empties this row's staged entry from outside — Discard, or a
  // save that dropped an untouched one — also abandons a seed still in flight.
  // Without this the reveal lands afterwards and re-creates the entry, and with
  // it an editor that opens by itself displaying a credential, seconds after the
  // user discarded everything. In an effect rather than in the render above,
  // because a ref must not be written during render; the reveal is a round trip
  // away, so the bump is always in place before it can land.
  useEffect(() => {
    if (edit === undefined) seedGeneration.current += 1;
  }, [edit]);

  /**
   * Whether the editor is open — asked of the staged work, not only of this
   * component's own state.
   *
   * `editingValue` is local to a row, and a row unmounts whenever the filter or
   * a reload stops listing it, while the staged value survives in the table. A
   * row that came back would then show a masked field with an "Unsaved" badge
   * over a value nobody could see — and clicking it to look would seed the
   * editor afresh and destroy what had been typed. Anything staged reopens the
   * editor on it instead.
   */
  const editorOpen =
    editingValue || (edit !== undefined && (edit.baseline !== undefined || edit.value.length > 0));

  /**
   * Opens the editor on the current value.
   *
   * The reveal is the audited one, and it is skipped when the plaintext is
   * already here — handed over by the field, which holds whatever the eye or a
   * "Reveal all" fetched. Those reads were audited when they happened, and
   * issuing a second request for the same value would put two records in the log
   * for one act.
   */
  async function beginEdit(cached?: string) {
    if (editorOpen) return;

    const generation = seedGeneration.current + 1;
    seedGeneration.current = generation;

    setSeedError(null);
    setEditingValue(true);
    onEditOpen();

    const known = cached ?? revealed;
    if (known !== undefined) {
      onEditSeed(known);
      return;
    }

    setPrefilling(true);
    try {
      const plaintext = await reveal();
      if (seedGeneration.current !== generation) return;
      onEditSeed(plaintext);
    } catch (cause) {
      if (seedGeneration.current !== generation) return;
      // The editor stays open and empty: the value could not be read, but
      // writing a new one does not require having read the old one.
      setSeedError(errorMessage(cause));
    } finally {
      if (seedGeneration.current === generation) setPrefilling(false);
    }
  }

  function cancelEdit() {
    // Abandons any seed still in flight, so its plaintext cannot land in state
    // after the user has closed the box.
    seedGeneration.current += 1;
    setEditingValue(false);
    setPrefilling(false);
    setSeedError(null);
    onEditCancel();
  }

  const staged = edit !== undefined && holdsWork(secret.name, edit);
  const valueType = toSecretValueType(edit?.valueType ?? secret.valueType);
  const comparing = compare.length > 0;
  /** The staged note where there is one, the stored note otherwise. */
  const note = edit?.note ?? secret.note;

  /**
   * Stages a note, or un-stages it when it is back to what is stored.
   *
   * `null` from the panel means "clear the note", which is staged as an empty
   * string — the save turns that into `note: null` on the wire. The two nulls
   * mean different things and this is where they are told apart.
   */
  function changeNote(next: string | null) {
    const value = next ?? '';
    onMetaChange({ note: value === (secret.note ?? '') ? null : value });
  }

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
        // A fixed height, and only one line of content in it. What used to add a
        // second — the note, the unsaved badge, the rename warning — is a
        // tooltip or an inline mark now. The one thing allowed to make a row
        // taller is a value opened for editing.
        'h-14',
        staged && 'bg-warning-tint/40 hover:bg-warning-tint/50',
        staged && '[&>td:first-child]:border-l-warning [&>td:first-child]:border-l-2',
        !staged && selected && 'bg-accent-tint/40',
      )}
    >
      <TableCell className="pr-0 align-top">
        <span className="flex h-9 items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(checked === true)}
            aria-label={`Select ${secret.name}`}
          />
        </span>
      </TableCell>

      <TableCell className="align-top">
        <NameCell
          secret={secret}
          edit={edit}
          existingNames={existingNames}
          disabled={disabled}
          valueType={valueType}
          staged={staged}
          note={note}
          onMetaChange={onMetaChange}
          onTypeChange={onTypeChange}
          onCommit={onCommit}
        />
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col gap-1.5">
          <ValueField
            secret={secret}
            secretName={secret.name}
            valueType={valueType}
            // The chip only earns its place once there is more than one value in
            // the cell; on its own it would repeat the page heading.
            {...(comparing && environment !== undefined
              ? {
                  environment: {
                    name: environment.name,
                    isProduction: environment.isProduction,
                  },
                }
              : {})}
            disabled={disabled}
            // Handed the plaintext a "Reveal all" already fetched and audited.
            // Without this the field would either re-fetch every row — sixty
            // audit records for one click — or show nothing.
            {...(revealed === undefined ? {} : { revealed })}
            onReveal={reveal}
            editing={editorOpen}
            draft={edit?.value ?? ''}
            // "Touched", not "would write": emptying a seeded box is the user
            // at work even though a save would skip it, and the editor must
            // stay open and cancellable while they paste the replacement.
            dirty={edit !== undefined && isTouched(edit)}
            prefilling={prefilling}
            error={seedError ?? edit?.error ?? null}
            onEditOpen={beginEdit}
            onDraftChange={onEditChange}
            onEditCancel={cancelEdit}
            onCommit={onCommit}
            note={note}
            onNoteChange={changeNote}
            onHistory={() => onHistory(envSlug)}
            onDelete={onDelete}
          />

          {compare.map((compared) => (
            <ComparedValue
              key={compared.slug}
              orgSlug={orgSlug}
              projectSlug={projectSlug}
              environment={compared}
              secretName={secret.name}
              secret={compared.byName.get(secret.name) ?? null}
              // Not `disabled` — that is this environment's save in flight, and
              // it has nothing to do with a field that writes to another one.
              // Several compared values can be open and saved at once.
              disabled={compared.loading}
              onHistory={() => onHistory(compared.slug)}
              onSaved={onComparedSaved}
            />
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * The key: its name and its declared type, on one line.
 *
 * ── Why the name is always an input ──
 * Renaming used to be behind a pencil, which is a click spent announcing that
 * text is text. The field is styled as a label until it is hovered or focused,
 * so a table of sixty reads as a table and not as a form — and clicking one
 * puts the cursor in it, which is what everybody tries first.
 *
 * A field typed and then restored to the stored text un-stages itself: the
 * comparison happens here, on every keystroke, so `pendingCount` never counts a
 * change that no longer exists.
 *
 * ── Why the note is a tooltip ──
 * It used to be a second input under the name, which cost every row in the table
 * a second line so that the few rows with a note could show it. Hovering the key
 * says it instead, and the panel beside the value writes it. A row is one line
 * high; only a value opened for editing may make it taller.
 *
 * ── Why the type sits here, at a fixed width ──
 * `integer`, `url`, `json` describe the shape of the value, but the thing a
 * person is looking at when they think about it is the key: `PORT` is an
 * integer, and that reads as a property of `PORT`. Fixed width because the
 * labels differ in length and a ragged column of them turns the name beside it
 * into a ragged column too.
 */
function NameCell({
  secret,
  edit,
  existingNames,
  disabled,
  valueType,
  staged,
  note,
  onMetaChange,
  onTypeChange,
  onCommit,
}: {
  secret: SecretSummary;
  edit: PendingEdit | undefined;
  existingNames: ReadonlySet<string>;
  disabled: boolean;
  valueType: SecretValueType;
  /** Whether this row holds work a save would write. */
  staged: boolean;
  /** The note in effect, shown on hover over the name. */
  note: string | null;
  onMetaChange: (patch: { name?: string | null; note?: string | null }) => void;
  onTypeChange: (type: SecretValueType) => void;
  onCommit: () => void;
}) {
  const shownName = edit?.name ?? secret.name;
  const rename = edit?.name?.trim();
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
    // Radix closes a tooltip on pointer-down and on Escape, but never on a
    // keystroke — so one attached to a text field opens when the field is
    // tabbed into and then hangs over the row for as long as the user types.
    setNoteTipOpen(false);

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
    }
  }

  const hasNote = note !== null && note.length > 0;
  const [noteTipOpen, setNoteTipOpen] = useState(false);

  const field = (
    <Input
      value={shownName}
      onChange={(event) => {
        const next = event.target.value;
        onMetaChange({ name: next === secret.name ? null : next });
      }}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      // The column is narrow and the input does not wrap, so a long name is
      // otherwise only readable by scrolling inside a field styled to look like
      // text. Where there is a note, the tooltip says that instead — it is the
      // thing worth reading, and two hover hints on one control is one too many.
      {...(hasNote ? {} : { title: shownName })}
      aria-label={`Name of ${secret.name}`}
      aria-invalid={nameProblem !== null ? true : undefined}
      maxLength={SECRET_NAME_MAX_LENGTH}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn(
        'h-9 min-w-0 px-2 font-mono text-sm font-medium',
        // A label until it is asked to be a field. The border and the well
        // arrive on hover and on focus, which is the moment they mean
        // something; at rest the column reads as text.
        'border-transparent bg-transparent',
        'hover:enabled:border-line-control hover:enabled:bg-canvas-inset',
        'focus-visible:border-line-control focus-visible:bg-canvas-inset',
        nameProblem !== null && 'border-danger bg-canvas-inset',
      )}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {staged ? (
          // The row is already tinted and carries a left border; this is the
          // same fact for a screen reader, and a mark for anyone who cannot
          // rely on the colour. Inline, because a badge on its own line would
          // give the table a second row height it otherwise never has.
          <span className="shrink-0" title="Unsaved changes">
            <span aria-hidden="true" className="bg-warning block size-1.5 rounded-full" />
            <span className="sr-only">Unsaved changes</span>
          </span>
        ) : null}

        {/* The note, where the key is — hovering the thing it annotates is where
            somebody looks for it. Writing it is in the panel beside the value;
            see `FieldDetails`.

            Always rendered, open only when there is something to say: swapping
            between a wrapped and an unwrapped input would change the element
            type at this position, and React would remount the field — dropping
            the cursor out of it the moment a note was added or cleared. */}
        <Tooltip content={note ?? ''} open={hasNote && noteTipOpen} onOpenChange={setNoteTipOpen}>
          {field}
        </Tooltip>

        {wantsRename && nameProblem === null ? (
          // Said while the rename is staged, not after: the history follows the
          // secret through a rename, but every reader addressing it by name —
          // `xecret run`, CI — stops finding it the moment this is saved. As an
          // icon rather than a line of text, because the line would be the only
          // thing in the table that changes a row's height.
          <Tooltip content={`Anything reading ${secret.name} by name stops finding it.`}>
            <span className="text-warning-text shrink-0" tabIndex={0}>
              <AlertTriangleIcon aria-hidden="true" className="size-4" />
              <span className="sr-only">
                Renaming this: anything reading {secret.name} by name stops finding it.
              </span>
            </span>
          </Tooltip>
        ) : null}

        <ValueTypeMenu
          value={valueType}
          onChange={onTypeChange}
          disabled={disabled}
          secretName={secret.name}
          // Fixed, so the type labels line up down the column instead of
          // starting wherever the name beside them happens to end. Wide enough
          // for the longest label — at `w-20` "Date and time" truncated to
          // "Date an…" directly beneath a distinct "Date".
          className="w-32 shrink-0 justify-between"
        />
      </div>

      {nameProblem !== null ? (
        <p className="text-danger-text px-2 text-sm leading-5">{nameProblem}</p>
      ) : null}
    </div>
  );
}
