'use client';

import { useMemo, useState } from 'react';

import { pluralize } from '@/lib/format';
import { Alert, Button, Textarea } from '@/components/ui';
import { parsePastedSecrets } from './paste-secrets';
import type { DraftSeed } from './staged-changes';

export interface BulkAddPanelProps {
  onAdd: (seeds: readonly DraftSeed[]) => void;
  onClose: () => void;
}

/**
 * Paste many keys at once, in the page rather than in a modal.
 *
 * ── Why this is not the import dialog ──
 * Import takes a *file*, plans it against what is already stored, applies a
 * conflict strategy, and writes — all server-side, in one request. This is the
 * other shape of the same need: a handful of lines out of a teammate's `.env`,
 * pasted into a box, which the user wants to look at and edit before anything
 * is written anywhere. So this panel writes nothing. It turns the paste into
 * rows in the table, and those rows go through the same review and the same
 * save button as a row typed by hand.
 *
 * That is also why the paste is parsed in the browser: a block of credentials
 * pasted by mistake, or into the wrong environment, never leaves the machine.
 *
 * The parsed *count* is shown, never the parsed values — the preview a person
 * needs here is "did it find eleven keys or one", and the values themselves are
 * about to appear in the table anyway, where they belong.
 */
export function BulkAddPanel({ onAdd, onClose }: BulkAddPanelProps) {
  const [text, setText] = useState('');

  const parsed = useMemo(
    () => (text.trim().length === 0 ? null : parsePastedSecrets(text)),
    [text],
  );
  const found = parsed?.seeds.length ?? 0;

  function handleAdd() {
    if (parsed === null || parsed.seeds.length === 0) return;
    onAdd(parsed.seeds);
    // Cleared before the panel closes: the pasted block is a wall of
    // credentials, and it has served its purpose the moment it becomes rows.
    setText('');
    onClose();
  }

  return (
    <div className="border-line bg-surface flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-fg text-sm font-medium">Add several at once</h2>
        <p className="text-fg-subtle text-xs">
          One <code className="font-mono">KEY=value</code> per line. Quoted multi-line values —
          certificates, private keys — are read whole.
        </p>
      </div>

      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={6}
        placeholder={'DATABASE_URL=postgres://…\nSTRIPE_SECRET_KEY=sk_live_…'}
        aria-label="Paste KEY=value lines"
        // Every assistant that could copy these values somewhere else is turned
        // off: autocomplete would offer them back on another form, and a spell
        // checker on some platforms sends its input to a remote service.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="font-mono text-[0.8125rem]"
        autoFocus
      />

      {parsed !== null && parsed.renamed.length > 0 ? (
        <Alert tone="info" title={`${pluralize(parsed.renamed.length, 'key')} renamed`}>
          <p>
            A secret name becomes an environment variable, so it may only hold letters, digits and
            underscores. These were corrected — edit any of them in the table before saving:
          </p>
          <ul className="mt-1.5 space-y-0.5 font-mono text-xs">
            {parsed.renamed.slice(0, 8).map((entry) => (
              <li key={entry.from} className="break-all">
                {entry.from} → {entry.to}
              </li>
            ))}
          </ul>
          {parsed.renamed.length > 8 ? (
            <p className="mt-1 text-xs">…and {parsed.renamed.length - 8} more.</p>
          ) : null}
        </Alert>
      ) : null}

      {parsed !== null && parsed.warnings.length > 0 ? (
        <Alert tone="warning" title={`${pluralize(parsed.warnings.length, 'line')} skipped`}>
          <ul className="space-y-0.5 text-xs">
            {parsed.warnings.slice(0, 5).map((warning) => (
              <li key={`${warning.line}-${warning.message}`}>{warning.message}</li>
            ))}
          </ul>
          {parsed.warnings.length > 5 ? (
            <p className="mt-1 text-xs">…and {parsed.warnings.length - 5} more.</p>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <p role="status" aria-live="polite" className="text-fg-subtle text-[0.8125rem]">
          {text.trim().length === 0
            ? 'Nothing pasted yet'
            : found === 0
              ? 'No KEY=value lines found'
              : `${pluralize(found, 'key')} ready to add`}
        </p>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleAdd} disabled={found === 0}>
          Add {found === 0 ? 'rows' : pluralize(found, 'row')}
        </Button>
      </div>
    </div>
  );
}
