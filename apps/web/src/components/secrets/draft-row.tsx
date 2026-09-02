'use client';

import { useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

import {
  checkSecretName,
  checkSecretValue,
  SECRET_NAME_MAX_LENGTH,
  toSecretValueType,
} from '@xecret/core/validation';
import type { SecretValueType } from '@xecret/core/validation';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import {
  Button,
  CloseIcon,
  Input,
  NoteIcon,
  TableCell,
  TableRow,
  Textarea,
  Tooltip,
  useToast,
} from '@/components/ui';
import { ValueTypeMenu } from './value-type-menu';
import { looksLikeAssignments, parsePastedSecrets } from './paste-secrets';
import { draftNameProblem, isBlankDraft } from './staged-changes';
import type { Draft, DraftSeed } from './staged-changes';

const NOTE_MAX_LENGTH = 1024;

export interface DraftRowProps {
  draft: Draft;
  drafts: readonly Draft[];
  existingNames: ReadonlySet<string>;
  disabled: boolean;
  onPatch: (patch: DraftSeed) => void;
  onExpand: (seeds: readonly DraftSeed[]) => void;
  onRemove: () => void;
  /** Another empty row after this one — what Enter in the value asks for. */
  onAddNext: () => void;
  /** Ctrl/Cmd+Enter anywhere in the row commits the whole batch. */
  onCommit: () => void;
}

/**
 * A secret being written, in the table rather than in a dialog.
 *
 * ── Why the value is not masked here ──
 * The user is the source of this value: they are looking at it in their
 * password manager or their terminal as they paste it. Masking would only make
 * verifying a paste impossible, and the protection that matters — that a
 * *stored* value is never rendered without an explicit, audited reveal — is a
 * property of the rows above this one, not of an input the user is typing into.
 *
 * ── The note is behind its own button ──
 * Exactly as on a saved row: the note mark on the trailing edge of the name
 * field opens a description field under it, and nothing opens it otherwise. A draft
 * used to carry that input open at all times, which gave every new row two lines
 * and a hint to read before the first character of the key was typed — for a
 * field that most new secrets never use.
 *
 * ── Enter walks the row ──
 * Key, then value, then the next new key: the shape of adding six secrets at
 * once, done without the pointer. Enter in the name moves to the value (past
 * the note, which almost no new secret has — Shift+Enter is how you ask for
 * that, and Enter from there carries on to the value as though you never had);
 * Enter in the value opens a fresh row below and puts the cursor in its name.
 *
 * A row is never *saved* by Enter, unlike the stored rows above it. A draft is
 * one of a batch being composed, the batch is written by one button, and a key
 * that saved itself the moment its value was typed would make "add six secrets"
 * six separate writes in the audit log.
 *
 * ── Paste expands ──
 * Pasting `KEY=value` text into the name field replaces this row with one row
 * per assignment. That is the fast path for the thing people actually do, which
 * is copy a block out of somebody's `.env` and want it here. A name can never
 * legally contain `=` or a newline, so intercepting that paste cannot swallow a
 * paste that was meant literally.
 */
export function DraftRow({
  draft,
  drafts,
  existingNames,
  disabled,
  onPatch,
  onExpand,
  onRemove,
  onAddNext,
  onCommit,
}: DraftRowProps) {
  const { toast } = useToast();

  // Mount-time only. A row added by the "Add secret" button arrives empty and
  // should take focus; the twenty rows a paste expands into arrive named, and
  // stealing focus to the last of them would scroll the user away from the
  // block they just pasted.
  const [focusOnMount] = useState(() => draft.name === '' && draft.value === '');

  /** The value box, for the Enter that walks here from the name or the note. */
  const valueRef = useRef<HTMLTextAreaElement>(null);

  /** Whether the note field is open under the name. Closed until asked for. */
  const [describing, setDescribing] = useState(false);
  /**
   * Hover only — see the note on the same pair in `SecretRow`. Radix would open
   * this on focus too and then leave it hanging over the row for as long as the
   * user typed.
   */
  const [noteTip, setNoteTip] = useState(false);

  const hasNote = draft.note.length > 0;

  const liveNameProblem = draftNameProblem(draft, drafts, existingNames);
  const nameError = draft.error?.field === 'name' ? draft.error.message : liveNameProblem;

  // The live shape check takes precedence over the last save attempt's message,
  // which may already describe a value the user has since changed. It runs
  // against the same module the server checks against on write — this copy is
  // for the person, that one is the rule.
  const valueType = toSecretValueType(draft.valueType);
  const shape = checkSecretValue(draft.value, valueType);
  const valueError = !shape.valid
    ? (shape.message ?? null)
    : draft.error?.field === 'value'
      ? draft.error.message
      : null;

  // Offered only when the validator can derive a legal name from an illegal
  // one (`my-api-key` → `MY_API_KEY`). Faster and less error-prone than
  // explaining the rule and hoping.
  const suggestion =
    draft.name.trim().length === 0 ? undefined : checkSecretName(draft.name.trim()).suggestion;

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (!looksLikeAssignments(text)) return;

    const { seeds, warnings, renamed } = parsePastedSecrets(text);
    if (seeds.length === 0) return;

    event.preventDefault();
    onExpand(seeds);

    // What the paste could not take, said out loud. A line the parser rejected
    // used to disappear between the clipboard and the table with nothing on
    // screen to say so — and a `.env` block is exactly the thing somebody pastes
    // once and assumes arrived whole. Neither the warnings nor the renames carry
    // a value; see the header of `paste-secrets.ts`.
    const parts: string[] = [];
    if (warnings.length > 0) parts.push(`${pluralize(warnings.length, 'line')} skipped`);
    if (renamed.length > 0) {
      parts.push(
        `${pluralize(renamed.length, 'key')} renamed (${renamed
          .slice(0, 3)
          .map((entry) => `${entry.from} → ${entry.to}`)
          .join(', ')}${renamed.length > 3 ? ', …' : ''})`,
      );
    }

    toast({
      variant: parts.length === 0 ? 'success' : 'info',
      title: `${pluralize(seeds.length, 'row')} added`,
      ...(parts.length === 0 ? {} : { description: `${parts.join('. ')}.` }),
    });
  }

  /** The name and the note. See the header for where Enter goes from each. */
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) onCommit();
      else if (event.shiftKey && !describing) setDescribing(true);
      else valueRef.current?.focus();
      return;
    }
    // Escape removes a row the user has not committed to. Only while it is
    // still blank: discarding a half-typed credential on a stray keypress is a
    // retype, and Escape is pressed by accident constantly.
    // `isBlankDraft` rather than name-and-value: this handler is on the note
    // field too, and asking the narrower question removed the whole row — note
    // included — when Escape was pressed to close a note that had just been
    // typed into.
    if (event.key === 'Escape' && isBlankDraft(draft)) {
      event.preventDefault();
      onRemove();
    }
  }

  function handleValueKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Ctrl/Cmd+Enter writes the batch; Enter on its own asks for one more row
      // to put in it. Shift+Enter falls through to the browser and types the
      // newline a PEM block needs.
      if (event.metaKey || event.ctrlKey) onCommit();
      else onAddNext();
      return;
    }
    if (event.key === 'Escape' && draft.name === '' && draft.value === '') {
      event.preventDefault();
      onRemove();
    }
  }

  return (
    <TableRow
      className={cn(
        // New rows read as new at a glance. Not by colour alone: the marker in
        // the first cell is an accent dot rather than a checkbox, the value is
        // unmasked because the user is its source, and the row carries a
        // discard button where the others carry a rail.
        'bg-accent-tint/30 hover:bg-accent-tint/40',
        'border-accent/60 [&>td:first-child]:border-l-accent [&>td:first-child]:border-l-2',
      )}
    >
      <TableCell className="pr-0 align-top">
        <span className="sr-only">New secret, not yet saved</span>
        {/* The same 36px box a saved row's checkbox sits in, so the two markers
            share an optical line down the left edge of the table. */}
        <span aria-hidden="true" className="flex h-9 items-center">
          <span className="bg-accent ml-1 block size-1.5 rounded-full" />
        </span>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Input
              value={draft.name}
              onChange={(event) => onPatch({ name: event.target.value })}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder="DATABASE_URL"
              aria-label="Secret name"
              aria-invalid={nameError !== null ? true : undefined}
              maxLength={SECRET_NAME_MAX_LENGTH}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              // `pr-8` always, so the field does not resize the moment a note is
              // typed into it.
              className="h-9 pr-8 font-mono text-sm"
              autoFocus={focusOnMount}
            />

            {/* On the trailing edge of the field, where the saved row keeps it,
                so nothing moves sideways the moment this row becomes one. */}
            <span className="absolute right-1 flex items-center">
              <Tooltip content={hasNote ? draft.note : 'Add a note'} open={noteTip && !describing}>
                <button
                  type="button"
                  onClick={() => {
                    setNoteTip(false);
                    setDescribing((open) => !open);
                  }}
                  onPointerEnter={() => setNoteTip(true)}
                  onPointerLeave={() => setNoteTip(false)}
                  disabled={disabled}
                  aria-label={hasNote ? 'Note on this new secret — show it' : 'Add a note'}
                  aria-expanded={describing}
                  className={cn(
                    'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors',
                    'hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-60',
                    hasNote || describing ? 'text-accent-text' : 'text-fg-subtle hover:text-fg',
                  )}
                >
                  <NoteIcon aria-hidden="true" className="size-4" />
                </button>
              </Tooltip>
            </span>
          </div>

          {/* Beside the name, exactly where the saved row keeps it, so nothing
              moves sideways the moment this row becomes one. */}
          <ValueTypeMenu
            value={draft.valueType}
            onChange={(next: SecretValueType) => onPatch({ valueType: next })}
            disabled={disabled}
            secretName={draft.name.trim() || 'this new secret'}
            // The width a saved row gives it, so the two columns of type labels
            // are one column. `w-32`, not `w-20`: see the note on the saved
            // row, which explains the width.
            className="w-32 shrink-0 justify-between"
          />
        </div>

        {nameError !== null ? (
          <p className="text-danger-text mt-1 text-sm leading-5">{nameError}</p>
        ) : null}

        {suggestion !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            className="mt-1.5 h-7 font-mono text-sm"
            disabled={disabled}
            onClick={() => onPatch({ name: suggestion })}
          >
            Use {suggestion}
          </Button>
        ) : null}

        {/* Beneath the name it annotates — the same place a saved row shows it,
            so the draft reads like the row it is about to become. */}
        {describing ? (
          <Input
            value={draft.note}
            onChange={(event) => onPatch({ note: event.target.value })}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder="What this key is for, who owns it, when it rotates"
            aria-label="Note"
            maxLength={NOTE_MAX_LENGTH}
            autoComplete="off"
            className="mt-1.5 h-8 text-sm"
            // The click that opened it was a request to write a note.
            autoFocus
          />
        ) : null}
      </TableCell>

      <TableCell className="align-top">
        <div className="flex min-w-0 items-start gap-1.5">
          {/* No live byte counter: measuring the value on every keystroke would
              copy the plaintext into a fresh buffer each time, and the server's
              64 KB refusal already says exactly what is wrong. */}
          <Textarea
            ref={valueRef}
            value={draft.value}
            onChange={(event) => onPatch({ value: event.target.value })}
            onKeyDown={handleValueKeyDown}
            disabled={disabled}
            rows={1}
            placeholder="Paste the value"
            aria-label="Secret value"
            aria-invalid={valueError !== null ? true : undefined}
            // Every assistant that could copy this value somewhere else is turned
            // off: autocomplete would offer it back on another form, and a spell
            // checker on some platforms sends its input to a remote service.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(
              // `block` and `py-[7px]` for the reasons set out at length on the
              // stored rows' editor: the baseline gap under an inline-block
              // textarea, and the two pixels a 6px padding leaves at the bottom.
              'block field-sizing-content max-h-64 min-h-9 py-[7px] font-mono text-sm leading-5 break-all',
              // On the border this box already has rather than on a ring outside
              // it, for the reason given at length on the stored rows' editor:
              // the app-wide outline reads as the field growing under the
              // pointer. The two boxes are the same control at two ages and must
              // behave the same way.
              'focus-visible:border-accent focus-visible:outline-none',
              // `aria-invalid` is what paints the border — see `INPUT_BASE`.
              // A `focus:ring-*` colour here would tint a ring no utility in
              // this file gives a width to, and render nothing at all.
              valueError !== null && 'border-danger',
            )}
          />

          <span className="flex shrink-0">
            {/* Always visible, unlike the floating bar on a saved row: a draft is
                not yet anything, so there is no value to read and no hover state
                worth waiting for — and the way out of a row you just created has
                to be findable without hunting for it. */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              disabled={disabled}
              onClick={onRemove}
              aria-label={
                draft.name.trim().length === 0
                  ? 'Discard this new secret'
                  : `Discard ${draft.name.trim()}`
              }
            >
              <CloseIcon className="size-4" />
            </Button>
          </span>
        </div>

        {valueError !== null ? (
          <p className="text-danger-text mt-1 text-sm leading-5">{valueError}</p>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
