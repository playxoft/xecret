'use client';

import { useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';

import { checkSecretName, SECRET_NAME_MAX_LENGTH } from '@xecret/core/validation';
import { cn } from '@/lib/cn';
import { Button, CloseIcon, Input, TableCell, TableRow, Textarea } from '@/components/ui';
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
  // Mount-time only. A row added by the "Add secret" button arrives empty and
  // should take focus; the twenty rows a paste expands into arrive named, and
  // stealing focus to the last of them would scroll the user away from the
  // block they just pasted.
  const [focusOnMount] = useState(() => draft.name === '' && draft.value === '');

  const liveNameProblem = draftNameProblem(draft, drafts, existingNames);
  const nameError = draft.error?.field === 'name' ? draft.error.message : liveNameProblem;
  const valueError = draft.error?.field === 'value' ? draft.error.message : null;

  // Offered only when the validator can derive a legal name from an illegal
  // one (`my-api-key` → `MY_API_KEY`). Faster and less error-prone than
  // explaining the rule and hoping.
  const suggestion =
    draft.name.trim().length === 0 ? undefined : checkSecretName(draft.name.trim()).suggestion;

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (!looksLikeAssignments(text)) return;

    const { seeds } = parsePastedSecrets(text);
    if (seeds.length === 0) return;

    event.preventDefault();
    onExpand(seeds);
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
        // New rows read as new at a glance, without relying on colour alone:
        // they are also the only rows in the table whose name is an input.
        'bg-accent-tint/30 hover:bg-accent-tint/40',
        'border-accent/60 [&>td:first-child]:border-l-accent [&>td:first-child]:border-l-2',
      )}
    >
      <TableCell className="pr-0 align-top">
        <span className="sr-only">New secret, not yet saved</span>
        <span aria-hidden="true" className="bg-accent mt-2.5 ml-1 block size-1.5 rounded-full" />
      </TableCell>

      <TableCell className="align-top">
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
          className="h-8 font-mono text-[0.8125rem]"
          autoFocus={focusOnMount}
        />

        {nameError !== null ? (
          <p className="text-danger-text mt-1 text-xs leading-5">{nameError}</p>
        ) : null}

        {suggestion !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            className="mt-1.5 h-7 font-mono text-xs"
            disabled={disabled}
            onClick={() => onPatch({ name: suggestion })}
          >
            Use {suggestion}
          </Button>
        ) : null}
      </TableCell>

      <TableCell className="align-top">
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
          className="min-h-8 py-1.5 font-mono text-[0.8125rem] leading-5"
        />
        {valueError !== null ? (
          <p className="text-danger-text mt-1 text-xs leading-5">{valueError}</p>
        ) : null}
      </TableCell>

      <TableCell colSpan={3} className="align-top">
        <Input
          value={draft.note}
          onChange={(event) => onPatch({ note: event.target.value })}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Note (optional)"
          aria-label="Note"
          maxLength={NOTE_MAX_LENGTH}
          autoComplete="off"
          className="h-8 text-[0.8125rem]"
        />
        <p className="text-fg-subtle mt-1 text-xs leading-5">Never put part of the value here.</p>
      </TableCell>

      <TableCell className="align-top">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
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
      </TableCell>
    </TableRow>
  );
}
