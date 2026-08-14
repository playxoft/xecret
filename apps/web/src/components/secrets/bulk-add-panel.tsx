'use client';

import { useMemo, useState } from 'react';

import { pluralize } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Textarea } from '@/components/ui';
import { parsePastedSecrets } from './paste-secrets';
import type { DraftSeed } from './staged-changes';
import { writeToEnvironments } from './multi-environment-write';
import type { EnvironmentOutcome, EnvironmentTarget } from './multi-environment-write';

export interface BulkAddPanelProps {
  onAdd: (seeds: readonly DraftSeed[]) => void;
  onClose: () => void;
  /** The environment on screen. Always a target, and never deselectable. */
  currentEnvSlug: string;
  orgSlug: string;
  projectSlug: string;
  /** Every environment in this project, in `sort_order`. */
  environments: readonly EnvironmentTarget[];
  /** Reloads the table after a write that touched the current environment. */
  onWritten: () => void;
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
export function BulkAddPanel({
  onAdd,
  onClose,
  currentEnvSlug,
  orgSlug,
  projectSlug,
  environments,
  onWritten,
}: BulkAddPanelProps) {
  const [text, setText] = useState('');
  // The current environment is always a target and is never in this set — it is
  // added back at use. Keeping it out means it cannot be deselected, which is
  // the invariant that lets the single-environment path stay the default.
  const [alsoWriteTo, setAlsoWriteTo] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<readonly EnvironmentOutcome[] | null>(null);

  const parsed = useMemo(
    () => (text.trim().length === 0 ? null : parsePastedSecrets(text)),
    [text],
  );
  const found = parsed?.seeds.length ?? 0;

  const others = environments.filter((environment) => environment.slug !== currentEnvSlug);
  const targets = environments.filter(
    (environment) => environment.slug === currentEnvSlug || alsoWriteTo.has(environment.slug),
  );
  const fanOut = alsoWriteTo.size > 0;
  const touchesProduction = targets.some((environment) => environment.isProduction);

  function toggleTarget(slug: string, checked: boolean) {
    setAlsoWriteTo((current) => {
      const next = new Set(current);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  function handleAdd() {
    if (parsed === null || parsed.seeds.length === 0) return;
    onAdd(parsed.seeds);
    // Cleared before the panel closes: the pasted block is a wall of
    // credentials, and it has served its purpose the moment it becomes rows.
    setText('');
    onClose();
  }

  /**
   * The fan-out path.
   *
   * Unlike `handleAdd`, this writes — there is nowhere to stage a pending row
   * for an environment that is not on screen. So it is confirmed first, and the
   * result is reported per environment rather than as a single "done".
   */
  async function handleFanOut() {
    if (parsed === null || parsed.seeds.length === 0) return;

    setConfirming(false);
    setProgress({ done: 0, total: targets.length });

    const results = await writeToEnvironments({
      orgSlug,
      projectSlug,
      targets,
      seeds: parsed.seeds,
      onProgress: (done, total) => setProgress({ done, total }),
    });

    setProgress(null);
    setOutcomes(results);
    // The pasted block is discarded even on a partial failure: it is a wall of
    // credentials, and the per-key report below says exactly what is still
    // outstanding without keeping them on screen.
    setText('');
    onWritten();
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

      <TargetPicker
        current={environments.find((environment) => environment.slug === currentEnvSlug)}
        others={others}
        selected={alsoWriteTo}
        onToggle={toggleTarget}
        disabled={progress !== null}
      />

      {outcomes !== null ? <FanOutResults outcomes={outcomes} /> : null}

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
        {fanOut ? (
          <Button
            variant={touchesProduction ? 'danger' : 'primary'}
            onClick={() => setConfirming(true)}
            disabled={found === 0 || progress !== null}
            loading={progress !== null}
          >
            {progress !== null
              ? `Writing ${progress.done}/${progress.total}…`
              : `Write to ${pluralize(targets.length, 'environment')}`}
          </Button>
        ) : (
          <Button variant="primary" onClick={handleAdd} disabled={found === 0}>
            Add {found === 0 ? 'rows' : pluralize(found, 'row')}
          </Button>
        )}
      </div>

      <FanOutConfirm
        open={confirming}
        onOpenChange={setConfirming}
        targets={targets}
        keyCount={found}
        touchesProduction={touchesProduction}
        onConfirm={handleFanOut}
      />
    </div>
  );
}

/**
 * Where the keys will go.
 *
 * Checkboxes rather than the capsule switcher above the table: this is a
 * multi-select over a set, not navigation, and reusing the switcher's shape here
 * would suggest clicking one takes you there.
 */
function TargetPicker({
  current,
  others,
  selected,
  onToggle,
  disabled,
}: {
  current: EnvironmentTarget | undefined;
  others: readonly EnvironmentTarget[];
  selected: ReadonlySet<string>;
  onToggle: (slug: string, checked: boolean) => void;
  disabled: boolean;
}) {
  if (others.length === 0) return null;

  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="text-fg-muted mb-1 text-xs font-medium">Also write to</legend>

      {current ? (
        <span className="text-fg-subtle inline-flex items-center gap-2 text-[0.8125rem]">
          {/* Always on and never interactive: the paste is happening on this
              environment's screen, so excluding it is not a coherent request. */}
          <Checkbox checked disabled aria-label={`${current.name} (always included)`} />
          {current.name}
          <span className="text-fg-subtle text-xs">(this one)</span>
        </span>
      ) : null}

      {others.map((environment) => (
        <label
          key={environment.slug}
          className={cn(
            'text-fg-muted inline-flex cursor-pointer items-center gap-2 text-[0.8125rem]',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <Checkbox
            checked={selected.has(environment.slug)}
            onCheckedChange={(checked) => onToggle(environment.slug, checked === true)}
            disabled={disabled}
          />
          {environment.name}
          {environment.isProduction ? <Badge tone="production">Production</Badge> : null}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The confirmation before a fan-out write.
 *
 * Typed when production is among the targets, for the same reason deleting a
 * production secret is: a dialog whose button sits under the pointer is a speed
 * bump people learn to clear without reading, and typing a word cannot be
 * satisfied by muscle memory.
 */
function FanOutConfirm({
  open,
  onOpenChange,
  targets,
  keyCount,
  touchesProduction,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: readonly EnvironmentTarget[];
  keyCount: number;
  touchesProduction: boolean;
  onConfirm: () => Promise<void>;
}) {
  const title = `Write ${pluralize(keyCount, 'key')} to ${pluralize(targets.length, 'environment')}?`;
  const description =
    'A key an environment already has is skipped, never overwritten — this fills gaps rather than replacing values. Each write is recorded in the audit log.';

  const list = (
    <ul className="text-fg-muted space-y-1 text-sm">
      {targets.map((environment) => (
        <li key={environment.slug} className="flex items-center gap-2">
          {environment.name}
          {environment.isProduction ? <Badge tone="production">Production</Badge> : null}
        </li>
      ))}
    </ul>
  );

  if (touchesProduction) {
    return (
      <ConfirmDialog
        strength="production"
        confirmPhrase="production"
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        confirmLabel="Write them"
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
      confirmLabel="Write them"
      confirmVariant="primary"
      onConfirm={onConfirm}
    >
      {list}
    </ConfirmDialog>
  );
}

/**
 * What actually happened, per environment.
 *
 * Reported rather than collapsed into a toast, because a fan-out over four
 * environments has four separate answers and "18 of 24 written" tells nobody
 * which six are missing. Skipped keys are named as well as counted: "already
 * there" is usually the expected outcome, and a user who sees a skip they did
 * not expect has found a value that differs between environments.
 */
function FanOutResults({ outcomes }: { outcomes: readonly EnvironmentOutcome[] }) {
  const failed = outcomes.reduce((total, outcome) => total + outcome.failed, 0);

  return (
    <Alert
      tone={failed > 0 ? 'danger' : 'success'}
      title={failed > 0 ? `${pluralize(failed, 'key')} could not be written` : 'Written'}
    >
      <ul className="space-y-1.5 text-xs">
        {outcomes.map((outcome) => (
          <li key={outcome.slug}>
            <span className="font-medium">{outcome.name}</span>
            {' — '}
            {outcome.created} written
            {outcome.skipped > 0 ? `, ${outcome.skipped} already there` : ''}
            {outcome.failed > 0 ? `, ${outcome.failed} failed` : ''}
            {outcome.failed > 0 ? (
              <ul className="mt-0.5 ml-3 space-y-0.5 font-mono break-all">
                {outcome.keys
                  .filter((key) => key.status === 'failed')
                  .map((key) => (
                    <li key={key.name}>
                      {key.name}: {key.reason}
                    </li>
                  ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
