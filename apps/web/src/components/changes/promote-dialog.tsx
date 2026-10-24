'use client';

import { useMemo, useState } from 'react';

import { pluralize } from '@/lib/format';
import {
  buildPromotionBody,
  buildPromotionDiff,
  defaultSelection,
  postPromotion,
  promotionPolicyProblems,
  readSnapshot,
  SnapshotUnavailableError,
} from '@/components/envkeys/promotion';
import type {
  EnvironmentSnapshot,
  PromotionBody,
  PromotionItem,
  PromotionResponse,
  PromotionStatus,
} from '@/components/envkeys/promotion';
import { ChangeError } from '@/components/plans/plan-notice';
import { useSecretPolicy } from '@/components/policies/secret-policy-context';
import type { Environment } from '@/components/projects/types';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  SecretValue,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useVaultKeys } from '@/components/vault';

export interface PromoteDialogProps {
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  /** The environment being promoted *into* — the one whose page this is. */
  target: Pick<Environment, 'slug' | 'name' | 'isProduction' | 'encryptionMode'>;
  /** Every environment of the project, from which a source is chosen. */
  environments: readonly Environment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a promotion wrote anything, so the screen re-reads what it shows. */
  onPromoted: () => void;
}

const STATUS: Readonly<Record<PromotionStatus, { label: string; tone: BadgeTone }>> = {
  added: { label: 'New here', tone: 'success' },
  changed: { label: 'Changed', tone: 'warning' },
  unchanged: { label: 'Same', tone: 'neutral' },
  removed: { label: 'Only here', tone: 'danger' },
  unreadable: { label: 'Cannot read', tone: 'neutral' },
};

/**
 * "Promote from…" — making this environment hold what another one holds (P19 §3).
 *
 * ── Three steps, and why the middle one cannot be skipped ──
 * Choose a source; review the diff; apply. The review is the point of the
 * feature: a promotion is the change a team most often wants to make in one go
 * and most often regrets making blind — staging's debug flag, a test key,
 * yesterday's value of something production has since rotated. So every
 * difference is listed, each value masked until somebody asks to see it, and
 * nothing is written until the server has run the whole promotion as a dry run
 * and said what it would do.
 *
 * ── What is offered, and what is assumed ──
 * Additions and changes are ticked by default — that is what "promote" means.
 * Secrets this environment holds and the source does not are listed and left
 * unticked: removing them is a choice, never a side effect. Identical values are
 * counted, not listed row by row, because a list of sixty "same" rows hides the
 * three that matter.
 *
 * ── The cryptography is not here ──
 * `components/envkeys/promotion.ts` reads both environments, opens both, builds
 * the diff and re-encrypts each promoted value for the target's row and key.
 * This dialog holds the result — every value of both environments, decrypted —
 * for as long as it is open, and nowhere else: Radix unmounts the content on
 * close, and the state goes with it.
 */
export function PromoteDialog({ open, onOpenChange, ...props }: PromoteDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-4xl">
        <PromoteBody {...props} onOpenChange={onOpenChange} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { kind: 'choose' }
  | {
      kind: 'review';
      source: EnvironmentSnapshot;
      target: EnvironmentSnapshot;
      sourceName: string;
      items: PromotionItem[];
    };

function PromoteBody({
  orgSlug,
  orgId,
  projectSlug,
  target,
  environments,
  onOpenChange,
  onPromoted,
  onBusyChange,
}: Omit<PromoteDialogProps, 'open'> & { onBusyChange: (busy: boolean) => void }) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const policy = useSecretPolicy();

  const [sourceSlug, setSourceSlug] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<{
    body: PromotionBody;
    response: PromotionResponse;
  } | null>(null);
  const [busy, setBusyState] = useState<'reading' | 'previewing' | 'applying' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [typed, setTyped] = useState('');

  function setBusy(next: typeof busy) {
    setBusyState(next);
    onBusyChange(next !== null);
  }

  /** Sources a promotion can come from: the project's other end-to-end encrypted environments. */
  const candidates = environments.filter((environment) => environment.slug !== target.slug);

  async function compare() {
    if (sourceSlug === '' || busy !== null) return;
    const source = candidates.find((environment) => environment.slug === sourceSlug);
    if (source === undefined) return;

    setBusy('reading');
    setError(null);
    setPreview(null);
    try {
      // Sequential: two audited pulls, each its own `secret.read` record, and
      // the second is pointless if the first is refused.
      const read = await readSnapshot({
        ref: { orgSlug, projectSlug, envSlug: source.slug },
        orgId,
        vault,
        label: source.name,
      });
      const here = await readSnapshot({
        ref: { orgSlug, projectSlug, envSlug: target.slug },
        orgId,
        vault,
        label: target.name,
      });
      const items = buildPromotionDiff(read, here);
      setPhase({ kind: 'review', source: read, target: here, sourceName: source.name, items });
      setSelected(defaultSelection(items));
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const review = phase.kind === 'review' ? phase : null;

  const problems = useMemo(
    () =>
      review === null
        ? []
        : promotionPolicyProblems(policy, review.items, selected, target.isProduction),
    [review, policy, selected, target.isProduction],
  );

  const chosen = useMemo(() => {
    if (review === null) return { writes: 0, removals: 0 };
    let writes = 0;
    let removals = 0;
    for (const item of review.items) {
      if (!selected.has(item.name)) continue;
      if (item.status === 'removed') removals += 1;
      else if (item.status === 'added' || item.status === 'changed') writes += 1;
    }
    return { writes, removals };
  }, [review, selected]);

  function toggle(name: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
    // A preview describes one selection. Changing it makes the preview a
    // promise about something else.
    setPreview(null);
  }

  async function runPreview() {
    if (review === null || busy !== null || problems.length > 0) return;
    setBusy('previewing');
    setError(null);
    try {
      // Built once and sent twice: the apply posts these exact bytes with
      // `dryRun: false`, so the preview's verdict is a verdict on them.
      const body = await buildPromotionBody({
        orgId,
        sourceSlug: review.source.ref.envSlug,
        target: review.target,
        items: review.items,
        selected,
        dryRun: true,
      });
      const response = await postPromotion(review.target.ref, body);
      setPreview({ body, response });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (review === null || preview === null || busy !== null) return;
    setBusy('applying');
    setError(null);
    try {
      const response = await postPromotion(review.target.ref, { ...preview.body, dryRun: false });
      const { created, updated, deleted } = response.counts;
      toast({
        variant: 'success',
        title: `Promoted ${review.sourceName} into ${target.name}`,
        description: summary(response),
      });
      if (created + updated + deleted > 0) onPromoted();
      onOpenChange(false);
    } catch (cause) {
      // A version conflict means something wrote between the preview and now:
      // the preview is discarded so the next attempt is built from a fresh read.
      setPreview(null);
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const needsPhrase = target.isProduction;
  const phraseOk = !needsPhrase || typed === target.slug;

  return (
    <>
      <DialogHeader>
        {target.isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>Promote into {target.name}</DialogTitle>
        <DialogDescription>
          Copy another environment’s values into this one. Everything is compared here, in your
          browser, with every value masked until you ask; nothing is written until the server has
          previewed the whole change, and then all of it lands or none of it does.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {error !== null ? (
          error instanceof SnapshotUnavailableError ? (
            <Alert tone="warning" title="That environment cannot be read here">
              <p>{error.message}</p>
            </Alert>
          ) : (
            <ChangeError error={error} title="The promotion did not go through" />
          )
        ) : null}

        {review === null ? (
          <Field
            label="Promote from"
            hint="Only this environment’s own values are compared and promoted. Inherited values belong to the environment they come from, and a template is promoted as its text, to be resolved wherever it lands."
          >
            <Select value={sourceSlug} onValueChange={setSourceSlug}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an environment" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((environment) => (
                  <SelectItem
                    key={environment.slug}
                    value={environment.slug}
                    // A server-mode environment has no client key to compare or
                    // re-encrypt with; shown, so its absence is not a mystery.
                    disabled={environment.encryptionMode !== 'e2ee'}
                  >
                    {environment.name}
                    {environment.encryptionMode !== 'e2ee' ? ' — not end-to-end encrypted' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <ReviewTable
            review={review}
            targetName={target.name}
            selected={selected}
            onToggle={toggle}
            disabled={busy !== null}
          />
        )}

        {problems.length > 0 ? (
          <Alert tone="danger" title="The organisation’s secret policy refuses some of these">
            <ul className="list-disc space-y-1 pl-5">
              {problems.map((problem) => (
                <li key={problem.name}>
                  <span className="text-fg font-mono">{problem.name}</span>: {problem.message}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">Untick them to promote the rest, or fix them at the source.</p>
          </Alert>
        ) : null}

        {preview !== null ? (
          <Alert tone="info" title="The server’s preview">
            <p>{summary(preview.response)}</p>
            <p className="mt-1">
              Nothing has been written yet.{' '}
              {preview.response.counts.unchanged > 0
                ? 'A value the server reports as unchanged already matched, by its tag, and appends no version.'
                : ''}
            </p>
          </Alert>
        ) : null}

        {preview !== null && needsPhrase ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-confirm">
              Type <span className="text-fg font-mono font-semibold">{target.slug}</span> to promote
              into production
            </Label>
            <Input
              id="promote-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
          Cancel
        </Button>
        {review === null ? (
          <Button
            variant="primary"
            onClick={() => void compare()}
            loading={busy === 'reading'}
            disabled={sourceSlug === ''}
          >
            Compare
          </Button>
        ) : preview === null ? (
          <Button
            variant="primary"
            onClick={() => void runPreview()}
            loading={busy === 'previewing'}
            disabled={chosen.writes + chosen.removals === 0 || problems.length > 0}
          >
            Preview {pluralize(chosen.writes + chosen.removals, 'change')}
          </Button>
        ) : (
          <Button
            variant={target.isProduction ? 'danger' : 'primary'}
            onClick={() => void apply()}
            loading={busy === 'applying'}
            disabled={!phraseOk}
          >
            {target.isProduction ? 'Promote into production' : `Promote into ${target.name}`}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** "2 created, 1 updated, 1 removed, 4 unchanged", from what the server answered. */
function summary(response: PromotionResponse): string {
  const { created, updated, deleted, unchanged } = response.counts;
  const parts = [
    ...(created > 0 ? [`${pluralize(created, 'secret')} created`] : []),
    ...(updated > 0 ? [`${updated} updated`] : []),
    ...(deleted > 0 ? [`${deleted} removed`] : []),
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
  ];
  return parts.length === 0 ? 'Nothing to change.' : `${parts.join(', ')}.`;
}

/**
 * The diff, one row per difference.
 *
 * Each value is a `SecretValue` holding a plaintext already decrypted for the
 * comparison: revealing one shows it for the same window every other reveal in
 * the product uses, and hides it when the tab is hidden. The audited read
 * happened once, when both environments were pulled for the comparison.
 */
function ReviewTable({
  review,
  targetName,
  selected,
  onToggle,
  disabled,
}: {
  review: Extract<Phase, { kind: 'review' }>;
  targetName: string;
  selected: ReadonlySet<string>;
  onToggle: (name: string, checked: boolean) => void;
  disabled: boolean;
}) {
  const shown = review.items.filter((item) => item.status !== 'unchanged');
  const same = review.items.length - shown.length;

  if (shown.length === 0) {
    return (
      <Alert tone="success" title="Nothing to promote">
        {targetName} already holds every value {review.sourceName} holds
        {same > 0 ? ` (${pluralize(same, 'secret')}, all the same)` : ''}.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted text-sm">
        {pluralize(shown.length, 'difference')} between {review.sourceName} and {targetName}
        {same > 0 ? `; ${pluralize(same, 'secret')} already the same` : ''}. Additions and changes
        are ticked; a secret only {targetName} holds is removed only if you tick it.
      </p>
      <TableContainer aria-label="Differences to promote" className="max-h-[50vh] overflow-y-auto">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <span className="sr-only">Include</span>
              </TableHead>
              <TableHead className="w-[28%]">Key</TableHead>
              <TableHead>In {review.sourceName}</TableHead>
              <TableHead>In {targetName} now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((item) => {
              const status = STATUS[item.status];
              const selectable = item.status !== 'unreadable';
              return (
                <TableRow key={item.name}>
                  <TableCell className="align-top">
                    <Checkbox
                      checked={selectable && selected.has(item.name)}
                      onCheckedChange={(checked) => onToggle(item.name, checked === true)}
                      disabled={disabled || !selectable}
                      aria-label={
                        item.status === 'removed'
                          ? `Remove ${item.name} from ${targetName}`
                          : `Promote ${item.name}`
                      }
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <p className="text-fg truncate font-mono text-sm" title={item.name}>
                      {item.name}
                    </p>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {item.typeChanged && item.source !== null && item.target !== null ? (
                        <Badge tone="accent">
                          {item.target.valueType} → {item.source.valueType}
                        </Badge>
                      ) : null}
                    </span>
                    {item.status === 'unreadable' ? (
                      <p className="text-fg-subtle mt-1 text-sm leading-5">
                        Written under a key this browser does not hold, so there is nothing to
                        promote.
                      </p>
                    ) : item.targetUnknown ? (
                      <p className="text-fg-subtle mt-1 text-sm leading-5">
                        {targetName}’s current value could not be read here, so it is offered as a
                        change; the server reports it unchanged if it already matches.
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    <ValueCell
                      label={`${item.name} in ${review.sourceName}`}
                      value={item.source?.value ?? null}
                      absent={item.source === null}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <ValueCell
                      label={`${item.name} in ${targetName}`}
                      value={item.target?.value ?? null}
                      absent={item.target === null}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}

function ValueCell({
  label,
  value,
  absent,
}: {
  label: string;
  value: string | null;
  absent: boolean;
}) {
  if (absent) return <span className="text-fg-subtle text-sm">Not set</span>;
  if (value === null) return <span className="text-fg-subtle text-sm">Cannot be read here</span>;
  return <SecretValue name={label} onReveal={() => Promise.resolve(value)} />;
}
