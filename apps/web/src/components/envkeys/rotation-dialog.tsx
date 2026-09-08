'use client';

import { useEffect, useState } from 'react';

import { errorMessage, isApiError } from '@/lib/api';
import { pluralize } from '@/lib/format';
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
  Skeleton,
  Spinner,
  useToast,
} from '@/components/ui';
import { useVaultKeys } from '@/components/vault';
import { fetchRecipients } from './env-keys';
import type { EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { FingerprintList } from './fingerprint-badge';
import { planRotation, rotateEnvironment } from './rotation';
import type { RotationPlan } from './rotation';

/**
 * The rotation ceremony.
 *
 * ── Why this is a modal with a progress list rather than a button ──
 * A rotation is not one request. It generates a key, seals it once per
 * principal, and posts the complete set — and on a forty-person environment the
 * sealing is forty X25519 operations that take visible time. A button that
 * simply spun would leave the operator unable to tell "still sealing" from
 * "hung", on the one action in the product that must not be abandoned halfway.
 * (It cannot actually be abandoned halfway — the write is one transaction — but
 * the operator does not know that while looking at a spinner.)
 *
 * ── What the copy has to say, and does ──
 * That rotating does **not** un-know the old values. Whoever was removed read
 * what they read, and the credentials themselves are still live at whatever
 * provider issued them. Rotating the environment key stops them reading what is
 * written *next*; rotating the secrets is a separate act, and the dialog says so
 * rather than letting an incident review discover it later.
 *
 * ── Failure is rendered, not summarised ──
 * The server refuses an incomplete or over-complete grant set and names the
 * principals. Those messages are shown verbatim: they are the only actionable
 * thing about that refusal, and "your grant set is wrong" against a set of forty
 * gives an operator nothing.
 */
export interface RotationDialogProps {
  target: EnvironmentRef;
  /** The environment's currently-open key. Its EHK is carried forward. */
  material: EnvKeyMaterial;
  environmentName: string;
  isProduction: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Re-read the key state. The new grant is opened through the ordinary path. */
  onRotated: () => void;
}

export function RotationDialog({ open, onOpenChange, ...rest }: RotationDialogProps) {
  const [running, setRunning] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (running ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg">
        {/* One component down, because Radix unmounts a closed dialog's content
            — which is what makes each open re-read the recipient list rather
            than rotating against a roster that was current an hour ago. */}
        <RotationFlow {...rest} onOpenChange={onOpenChange} onRunningChange={setRunning} />
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; plan: RotationPlan }
  | { kind: 'running'; plan: RotationPlan; step: 'generating' | 'sealing' | 'writing' }
  | { kind: 'refused'; plan: RotationPlan; problems: readonly string[] }
  | { kind: 'failed'; plan: RotationPlan | null; error: unknown };

const STEP_LABEL: Record<'generating' | 'sealing' | 'writing', string> = {
  generating: 'Generating a new data key',
  sealing: 'Sealing it to each member and token',
  writing: 'Writing the new key and its grants',
};

function RotationFlow({
  target,
  material,
  environmentName,
  isProduction,
  onOpenChange,
  onRunningChange,
  onRotated,
}: Omit<RotationDialogProps, 'open'> & { onRunningChange: (running: boolean) => void }) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetchRecipients(target, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setPhase({
          kind: 'ready',
          plan: planRotation({
            currentVersion: response.activeEdk?.version ?? material.edkVersion,
            recipients: response.recipients,
            unsealable: response.unsealable,
          }),
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'failed', plan: null, error: cause });
      });

    return () => controller.abort();
  }, [target, material.edkVersion]);

  const plan = phase.kind === 'loading' ? null : (phase.plan ?? null);

  async function run() {
    if (vault === null || plan === null) return;

    onRunningChange(true);
    setPhase({ kind: 'running', plan, step: 'generating' });

    const outcome = await rotateEnvironment({
      target,
      vault,
      material,
      plan,
      onProgress: (step) => setPhase({ kind: 'running', plan, step }),
    });

    onRunningChange(false);

    if (outcome.status === 'rotated') {
      toast({
        variant: 'success',
        title: `Rotated ${environmentName} to key version ${outcome.version}`,
        description: `Re-shared with ${pluralize(outcome.grantCount, 'principal')}.`,
      });
      onOpenChange(false);
      onRotated();
      return;
    }

    if (outcome.status === 'incomplete') {
      setPhase({ kind: 'refused', plan, problems: outcome.problems });
      return;
    }

    setPhase({ kind: 'failed', plan, error: outcome.error });
  }

  const running = phase.kind === 'running';

  return (
    <>
      <DialogHeader>
        {isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>Rotate the key for {environmentName}</DialogTitle>
        <DialogDescription>
          A new data key is generated in this browser and sealed to everyone who may still read this
          environment. Every existing value stays readable — the values are re-encrypted lazily, as
          each one is next written.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
        <Alert tone="warning" title="Rotating the key does not un-know the old values">
          <p>
            Whoever lost access read what they read while they held the key, and those credentials
            are still live at whatever issued them. This stops them opening anything written from
            now on — it does not revoke a database password or an API key.
          </p>
          <p className="mt-2">
            Rotate the secrets themselves too: open each one, put a fresh value in, and save.
          </p>
        </Alert>

        {phase.kind === 'loading' ? (
          <div aria-busy="true" aria-label="Reading who holds this key" className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : plan === null ? null : (
          <>
            <p className="text-fg text-sm">
              The new key will be version{' '}
              <span className="font-mono font-medium">{plan.newVersion}</span> and sealed to{' '}
              <span className="font-medium">{pluralize(plan.recipients.length, 'principal')}</span>.
            </p>

            <FingerprintList recipients={plan.recipients} />

            {plan.unsealable.length > 0 ? (
              <Alert tone="warning" title="Some members cannot be given a key">
                <p>
                  {pluralize(plan.unsealable.length, 'member')} may read this environment but
                  {plan.unsealable.length === 1 ? ' has' : ' have'} not finished setting up a vault,
                  so there is no public key to seal to. The rotation will be refused until they do,
                  or until their access is removed.
                </p>
              </Alert>
            ) : null}
          </>
        )}

        {phase.kind === 'running' ? (
          <ol className="border-line bg-canvas-inset flex flex-col gap-2 rounded-lg border px-3.5 py-3">
            {(['generating', 'sealing', 'writing'] as const).map((step, index) => {
              const order = ['generating', 'sealing', 'writing'] as const;
              const current = order.indexOf(phase.step);
              const done = index < current;
              return (
                <li key={step} className="flex items-center gap-2.5 text-sm">
                  {index === current ? (
                    <Spinner className="size-4" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={done ? 'text-success-text' : 'text-fg-subtle'}
                    >
                      {done ? '✓' : '·'}
                    </span>
                  )}
                  <span className={index === current ? 'text-fg font-medium' : 'text-fg-muted'}>
                    {STEP_LABEL[step]}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {phase.kind === 'refused' ? (
          <Alert tone="danger" title="The server refused this grant set">
            <p>
              A rotation has to name every principal who may read this environment, and nobody else
              — a set that quietly omitted somebody would revoke them silently. The roster changed
              while this dialog was open:
            </p>
            <ul className="mt-2 space-y-0.5">
              {phase.problems.map((problem) => (
                <li key={problem} className="font-mono text-sm break-all">
                  {problem}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Close this and open it again to rotate against the current roster.
            </p>
          </Alert>
        ) : null}

        {phase.kind === 'failed' ? (
          <Alert tone="danger" title="The rotation did not happen">
            <p>{errorMessage(phase.error)}</p>
            <p className="mt-1.5">
              Nothing changed: the new key and every grant are written in one transaction, so it
              either lands completely or not at all.
            </p>
            {isApiError(phase.error) && phase.error.requestId ? (
              <p className="mt-1.5 text-sm">
                Request id: <code className="font-mono select-all">{phase.error.requestId}</code>
              </p>
            ) : null}
          </Alert>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>
          {phase.kind === 'refused' || phase.kind === 'failed' ? 'Close' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          onClick={run}
          loading={running}
          disabled={plan === null || vault === null || phase.kind === 'refused'}
        >
          Rotate the key
        </Button>
      </DialogFooter>
    </>
  );
}
