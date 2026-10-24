'use client';

import { useState } from 'react';

import { formatAbsoluteTime, pluralize } from '@/lib/format';
import type { EnvKeyMaterial } from '@/components/envkeys';
import {
  fetchRestorePlan,
  isoToLocalInput,
  localInputToIso,
  openRestorePlan,
  partialRestoreNotice,
  postRestore,
} from '@/components/envkeys/restore-point';
import type {
  OpenedRestore,
  RestoreAction,
  RestoreApplyResponse,
  RestorePlan,
} from '@/components/envkeys/restore-point';
import { ChangeError } from '@/components/plans/plan-notice';
import {
  Alert,
  Badge,
  Button,
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

export interface RestorePointDialogProps {
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  envSlug: string;
  environmentName: string;
  isProduction: boolean;
  /**
   * The environment's current, opened key — what every restored value is
   * re-encrypted under. `null` while this browser cannot open it, which the
   * dialog explains rather than offering a restore it could not perform.
   */
  material: EnvKeyMaterial | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a restore wrote anything, so the screen re-reads what it shows. */
  onRestored: () => void;
}

const ACTIONS: Readonly<Record<RestoreAction, { label: string; tone: BadgeTone; says: string }>> = {
  update: {
    label: 'Put back',
    tone: 'warning',
    says: 'Gets its value from then, as a new version. The current one stays in its history.',
  },
  recreate: {
    label: 'Re-create',
    tone: 'success',
    says: 'Deleted since. Created again as a new secret holding the value it had then.',
  },
  delete: {
    label: 'Remove',
    tone: 'danger',
    says: 'Created since. Soft-deleted, with its versions kept.',
  },
  unchanged: { label: 'Same', tone: 'neutral', says: 'Already holds the value it had then.' },
};

/** The default instant offered: an hour ago, to the minute. */
function anHourAgo(): string {
  const date = new Date(Date.now() - 3_600_000);
  date.setSeconds(0, 0);
  return isoToLocalInput(date.toISOString());
}

/**
 * "Restore to a point in time" (P19 §4).
 *
 * ── The preview is not optional ──
 * Pick an instant; see, for every secret, what the restore would do to it —
 * put an old value back, re-create something deleted since, remove something
 * created since — with each value masked until asked for; then apply. The
 * preview runs the restore as a dry run on the server, with the exact bytes the
 * apply will send, so what it shows is the restore's own verdict.
 *
 * ── The window ──
 * How far back a restore reaches is the plan's (`pitrDays`). This dialog does
 * not know it until the server has answered once — the plan is the server's to
 * read — so the first instant offered is an hour ago, and once a preview has
 * come back the picker is bounded by the window it reported. An instant past
 * the window is refused with the plan that reaches it, rendered as the plan
 * refusal it is.
 *
 * ── What it never does ──
 * Destroy history. Every act writes forward and leaves the record it found, so
 * a restore is itself restorable — undoing one is restoring to the minute
 * before it.
 *
 * The organisation's secret policy is deliberately not asked of a restore:
 * putting back what the environment held is a rollback, and refusing it because
 * a rule arrived since would make the rule the thing standing between a team
 * and its own last-known-good state. The values were held to whatever applied
 * when they were written.
 */
export function RestorePointDialog({ open, onOpenChange, ...props }: RestorePointDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-3xl">
        <RestoreBody {...props} onOpenChange={onOpenChange} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

interface Previewed {
  at: string;
  plan: RestorePlan;
  opened: OpenedRestore;
  response: RestoreApplyResponse;
}

function RestoreBody({
  orgSlug,
  orgId,
  projectSlug,
  envSlug,
  environmentName,
  isProduction,
  material,
  onOpenChange,
  onRestored,
  onBusyChange,
}: Omit<RestorePointDialogProps, 'open'> & { onBusyChange: (busy: boolean) => void }) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const target = { orgSlug, projectSlug, envSlug };

  const [instant, setInstant] = useState(anHourAgo);
  /**
   * The latest instant the picker offers: the moment the dialog opened.
   *
   * Captured once rather than read on every render — a render must not depend
   * on the clock — and a restore point a few minutes older than "now" is not a
   * restriction anybody notices. The server refuses the future either way.
   */
  const [ceiling] = useState(() => isoToLocalInput(new Date().toISOString()));
  /** Whether the instant typed is in the future. Decided when it is typed, against the clock then. */
  const [inFuture, setInFuture] = useState(false);
  const [reach, setReach] = useState<RestorePlan['window'] | null>(null);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [busy, setBusyState] = useState<'previewing' | 'applying' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [typed, setTyped] = useState('');

  function setBusy(next: typeof busy) {
    setBusyState(next);
    onBusyChange(next !== null);
  }

  const at = localInputToIso(instant);

  async function preview() {
    if (at === null || inFuture || busy !== null || material === null || vault === null) return;
    setBusy('previewing');
    setError(null);
    setPreviewed(null);
    try {
      const { plan } = await fetchRestorePlan(target, at);
      setReach(plan.window);
      const opened = await openRestorePlan({ plan, vault, orgId, material });
      if (opened.blocked.length > 0) {
        // Nothing to send to the server: it refuses a restore that leaves out a
        // value it owes, and the reason is on screen below.
        setPreviewed({
          at: plan.at,
          plan,
          opened,
          response: {
            dryRun: true,
            at: plan.at,
            counts: { updated: 0, recreated: 0, deleted: 0, unchanged: 0 },
            items: [],
            skipped: [],
          },
        });
        return;
      }
      const response = await postRestore(target, {
        at: plan.at,
        writes: opened.writes,
        dryRun: true,
      });
      setPreviewed({ at: plan.at, plan, opened, response });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (previewed === null || busy !== null || previewed.opened.blocked.length > 0) return;
    setBusy('applying');
    setError(null);
    try {
      const response = await postRestore(target, {
        at: previewed.at,
        writes: previewed.opened.writes,
        dryRun: false,
      });
      const { updated, recreated, deleted } = response.counts;
      toast({
        variant: 'success',
        title: `Restored ${environmentName} to ${formatAbsoluteTime(previewed.at)}`,
        description: summary(response),
      });
      if (updated + recreated + deleted > 0) onRestored();
      onOpenChange(false);
    } catch (cause) {
      // Something wrote between the preview and the apply. The preview no
      // longer describes the environment, so it goes; previewing again builds
      // the restore from what is there now.
      setPreviewed(null);
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const blocked = previewed?.opened.blocked ?? [];
  const writes = previewed?.response.counts;
  const changes = writes === undefined ? 0 : writes.updated + writes.recreated + writes.deleted;
  const phraseOk = !isProduction || typed === envSlug;
  const unlocked = vault !== null && material !== null;

  return (
    <>
      <DialogHeader>
        {isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>Restore {environmentName} to a point in time</DialogTitle>
        <DialogDescription>
          Put every secret back the way it was at a moment you choose: old values return as new
          versions, secrets deleted since come back, and secrets created since are removed. Nothing
          is lost — every step writes forward, so a restore can itself be undone.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {!unlocked ? (
          <Alert tone="warning" title="This environment’s key is not open here">
            <p>
              A restore re-encrypts every value it puts back, in this browser, under the
              environment’s current key. Unlock your vault — or ask for this environment’s key to be
              shared with you — and try again.
            </p>
          </Alert>
        ) : null}

        <Field
          label="Restore to"
          hint={
            reach === null
              ? 'In your own time zone. How far back you can go depends on the plan; the first preview says.'
              : `In your own time zone. This plan reaches back ${pluralize(reach.days, 'day')}, to ${formatAbsoluteTime(reach.earliest)}.`
          }
          error={inFuture ? 'A restore point cannot be in the future.' : null}
        >
          <Input
            type="datetime-local"
            value={instant}
            onChange={(event) => {
              const next = event.target.value;
              const iso = localInputToIso(next);
              setInstant(next);
              setInFuture(iso !== null && new Date(iso).getTime() > Date.now());
              // A preview is of one instant; a different instant needs its own.
              setPreviewed(null);
              setTyped('');
            }}
            max={ceiling}
            {...(reach === null ? {} : { min: isoToLocalInput(reach.earliest) })}
            disabled={busy !== null}
            className="max-w-64"
          />
        </Field>

        {error !== null ? (
          <ChangeError error={error} title="The restore did not go through" />
        ) : null}

        {previewed !== null ? (
          <PlanTable previewed={previewed} environmentName={environmentName} />
        ) : null}

        {blocked.length > 0 ? (
          <Alert tone="danger" title="This restore cannot be applied from here">
            <p>
              {blocked.join(', ')} {blocked.length === 1 ? 'has' : 'have'} a value to put back that
              did not open in this browser, and a restore has to write every value it changes —
              leaving one out would apply part of an instant. Somebody whose vault opens those keys
              can apply it.
            </p>
          </Alert>
        ) : null}

        {previewed !== null && blocked.length === 0 && isProduction && changes > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="restore-confirm">
              Type <span className="text-fg font-mono font-semibold">{envSlug}</span> to restore
              production
            </Label>
            <Input
              id="restore-confirm"
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
        {previewed === null || blocked.length > 0 ? (
          <Button
            variant="primary"
            onClick={() => void preview()}
            loading={busy === 'previewing'}
            disabled={!unlocked || at === null || inFuture}
          >
            Preview the restore
          </Button>
        ) : (
          <Button
            variant={isProduction ? 'danger' : 'primary'}
            onClick={() => void apply()}
            loading={busy === 'applying'}
            disabled={changes === 0 || !phraseOk}
          >
            {changes === 0 ? 'Nothing to restore' : `Restore ${pluralize(changes, 'change')}`}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function summary(response: RestoreApplyResponse): string {
  const { updated, recreated, deleted, unchanged } = response.counts;
  const parts = [
    ...(updated > 0 ? [`${pluralize(updated, 'value')} put back`] : []),
    ...(recreated > 0 ? [`${recreated} re-created`] : []),
    ...(deleted > 0 ? [`${deleted} removed`] : []),
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
  ];
  const skipped =
    response.skipped.length > 0 ? ` Left as they are: ${response.skipped.join(', ')}.` : '';
  return parts.length === 0 ? `Nothing to change.${skipped}` : `${parts.join(', ')}.${skipped}`;
}

/**
 * Every secret the restore touches, with what it would do.
 *
 * Unchanged rows are counted rather than listed, so the rows that change are the
 * ones on screen. A value is revealable where this browser opened it — which is
 * every value the restore writes — and masked until asked.
 */
function PlanTable({
  previewed,
  environmentName,
}: {
  previewed: Previewed;
  environmentName: string;
}) {
  const rows = previewed.opened.items.filter((entry) => entry.item.action !== 'unchanged');
  const same = previewed.opened.items.length - rows.length;
  const response = previewed.response;
  const partial = partialRestoreNotice(previewed.opened.items);

  return (
    <div className="flex flex-col gap-2">
      <Alert tone="info" title={`At ${formatAbsoluteTime(previewed.at)}`}>
        <p>
          {rows.length === 0
            ? `${environmentName} already holds exactly what it held then.`
            : summary(response)}
          {same > 0 && rows.length > 0 ? ` ${pluralize(same, 'secret')} already as it was.` : ''}
        </p>
        {rows.length > 0 ? <p className="mt-1">Nothing has been written yet.</p> : null}
      </Alert>
      {partial === null ? null : (
        <Alert tone="warning" title="Not everything can be put back">
          <p>{partial}</p>
        </Alert>
      )}

      {rows.length > 0 ? (
        <TableContainer aria-label="What the restore does" className="max-h-[45vh] overflow-y-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[32%]">Key</TableHead>
                <TableHead>Value then</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ item, value, problem }) => {
                const action = ACTIONS[item.action];
                return (
                  <TableRow key={item.name}>
                    <TableCell className="align-top">
                      <p className="text-fg truncate font-mono text-sm" title={item.name}>
                        {item.name}
                      </p>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge tone={problem === null ? action.tone : 'neutral'}>
                          {problem === null ? action.label : 'Left as it is'}
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      {problem === 'unavailable' ? (
                        <p className="text-fg-subtle text-sm leading-5">
                          Written under a key you no longer hold, so it cannot be put back by you.
                          It stays exactly as it is.
                        </p>
                      ) : problem === 'unreadable' ? (
                        <p className="text-danger-text text-sm leading-5">
                          Its key was served but the value did not open in this browser.
                        </p>
                      ) : item.action === 'delete' ? (
                        <p className="text-fg-subtle text-sm leading-5">{action.says}</p>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {value === null ? (
                            <span className="text-fg-subtle text-sm">Cannot be read here</span>
                          ) : (
                            <SecretValue
                              name={`${item.name} as it was`}
                              onReveal={() => Promise.resolve(value)}
                            />
                          )}
                          <p className="text-fg-subtle text-sm leading-5">{action.says}</p>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
    </div>
  );
}
