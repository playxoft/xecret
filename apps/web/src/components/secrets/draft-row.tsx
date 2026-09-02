'use client';

import { useState } from 'react';
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
import { Button, CloseIcon, Input, TableCell, TableRow, Textarea, useToast } from '@/components/ui';
import { ValueTypeMenu } from './value-type-menu';
import { looksLikeAssignments, parsePastedSecrets } from './paste-secrets';
import { draftNameProblem } from './staged-changes';
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
  onCommit,
}: DraftRowProps) {
  const { toast } = useToast();

  // Mount-time only. A row added by the "Add secret" button arrives empty and
  // should take focus; the twenty rows a paste expands into arrive named, and
  // stealing focus to the last of them would scroll the user away from the
  // block they just pasted.
  const [focusOnMount] = useState(() => draft.name === '' && draft.value === '');

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

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
      return;
    }
    // Escape removes a row the user has not committed to. Only while it is
    // still blank: discarding a half-typed credential on a stray keypress is a
    // retype, and Escape is pressed by accident constantly.
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
            className="h-9 font-mono text-sm"
            autoFocus={focusOnMount}
          />

          {/* Beside the name, exactly where the saved row keeps it, so nothing
              moves sideways the moment this row becomes one. */}
          <ValueTypeMenu
            value={draft.valueType}
            onChange={(next: SecretValueType) => onPatch({ valueType: next })}
            disabled={disabled}
            secretName={draft.name.trim() || 'this new secret'}
            // The width a saved row gives it, so the two columns of type labels
            // are one column. `w-32`, not `w-20`: see the note on the saved
            // row, where "Date and time" truncated to "Date an…" directly
            // beneath a distinct "Date".
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
        <Input
          value={draft.note}
          onChange={(event) => onPatch({ note: event.target.value })}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Note (optional)"
          aria-label="Note"
          maxLength={NOTE_MAX_LENGTH}
          autoComplete="off"
          className="mt-1.5 h-8 text-sm"
        />
        <p className="text-fg-subtle mt-1 text-sm leading-5">Never put part of the value here.</p>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex min-w-0 items-start gap-1.5">
          {/* No live byte counter: measuring the value on every keystroke would
              copy the plaintext into a fresh buffer each time, and the server's
              64 KB refusal already says exactly what is wrong. */}
          <Textarea
            value={draft.value}
            onChange={(event) => onPatch({ value: event.target.value })}
            onKeyDown={handleKeyDown}
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
              'min-h-9 py-1.5 font-mono text-sm leading-5',
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
