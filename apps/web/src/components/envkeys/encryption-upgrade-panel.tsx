'use client';

import { useEffect, useRef, useState } from 'react';

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
  Spinner,
  useToast,
} from '@/components/ui';
import { useVaultKeys } from '@/components/vault';
import type { EnvironmentRef } from './env-keys';
import {
  autoUpgradeEligible,
  fetchUpgradePreview,
  nothingChanged,
  runEncryptionUpgrade,
  UpgradeRefusedError,
} from './encryption-upgrade';
import type {
  UpgradeBlocker,
  UpgradeDetails,
  UpgradeOutcome,
  UpgradePreview,
  UpgradeStep,
} from './encryption-upgrade';

/**
 * What a `server`-mode environment shows about its encryption, and the way out
 * of it (ADR 0009, Phase 5).
 *
 * ── Two places, one component ──
 * On the environment's settings, inside the key card, where the question "what
 * is this encrypted under?" is asked; and above the environment's values, for
 * the people who can act on it, because that is the page they actually open.
 * The second is also where the **automatic upgrade** happens: an environment
 * with nothing in it — no secret, no deleted secret, no CI token — and nobody
 * else who may read it has nothing to decide and nobody to lock out, so the
 * member who may upgrade it upgrades it by opening it with an unlocked vault,
 * without a dialog. That is what turns the empty environments of the early
 * sign-ups end-to-end encrypted as their owners next look at them. Anywhere a
 * teammate may read the environment, the dialog asks, and shares the key with
 * them straight afterwards.
 *
 * ── Who sees what ──
 * Somebody who cannot manage the environment sees, on the settings card, the
 * one sentence that says what the server can read here, and nothing above the
 * values. Somebody who can sees the button — and, where the server says they
 * may not after all (no vault yet; CI tokens only an owner or admin may
 * revoke), why not. The server's answer comes from
 * `GET …/encryption-upgrade`, which refuses nobody and records nothing, so
 * asking it on every page view costs no audit noise and no rate limit.
 */
export interface EncryptionUpgradePanelProps {
  target: EnvironmentRef;
  /** The organisation id, an AAD component of every value. `null` until the session loads. */
  orgId: string | null;
  environmentName: string;
  isProduction: boolean;
  /** The coarse "may manage this environment" from the session. The server decides. */
  canManage: boolean;
  /** `card` inside the key card; `banner` above the values, admins only. */
  placement: 'card' | 'banner';
  /** Re-read the key state (and anything else) once the environment is upgraded. */
  onUpgraded: () => void;
}

/**
 * Environments this tab has already tried to upgrade automatically, so a
 * re-render, a remount or React's development double effect cannot start a
 * second one — and a failure is not retried in a loop.
 */
const automaticAttempts = new Set<string>();

/** Of those, the ones that did not land — offered the dialog instead, never retried. */
const automaticFailures = new Set<string>();

function attemptKey(target: EnvironmentRef): string {
  return `${target.orgSlug}/${target.projectId}/${target.envSlug}`;
}

export function EncryptionUpgradePanel({
  target,
  orgId,
  environmentName,
  isProduction,
  canManage,
  placement,
  onUpgraded,
}: EncryptionUpgradePanelProps) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [automatic, setAutomatic] = useState<'idle' | 'failed' | 'unconfirmed'>('idle');
  const [attempt, setAttempt] = useState(0);
  const latestUpgraded = useRef(onUpgraded);
  useEffect(() => {
    latestUpgraded.current = onUpgraded;
  }, [onUpgraded]);

  const { orgSlug, projectId, envSlug } = target;

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    fetchUpgradePreview({ orgSlug, projectId, envSlug }, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return;
        setPreview(answer);
        setPreviewFailed(false);
      })
      .catch(() => {
        // A 403 (the session's coarse answer was wider than the server's) or a
        // 409 (upgraded in another tab) both mean "nothing to offer here".
        if (!controller.signal.aborted) setPreviewFailed(true);
      });
    return () => controller.abort();
  }, [canManage, orgSlug, projectId, envSlug, attempt]);

  // ── The automatic upgrade ──
  // Only from the banner placement, so one page cannot start it twice, and only
  // when the server's own preview says there is nothing to decide. "Running" is
  // derived rather than stored: eligible, and not already failed in this tab.
  const key = attemptKey({ orgSlug, projectId, envSlug });
  const automaticRunning =
    placement === 'banner' &&
    preview !== null &&
    vault !== null &&
    orgId !== null &&
    autoUpgradeEligible(preview, true) &&
    automatic === 'idle' &&
    !automaticFailures.has(key);

  useEffect(() => {
    if (!automaticRunning || preview === null || vault === null || orgId === null) return;
    if (automaticAttempts.has(key)) return;
    automaticAttempts.add(key);

    void runEncryptionUpgrade({
      target: { orgSlug, projectId, envSlug },
      orgId,
      vault,
      preview,
      // Nobody asked, so nobody is sealed to: the key shares the upgrade queues
      // wait for the pending-shares banner, where sealing to a teammate's key
      // stays something a person does on purpose.
      share: false,
      automatic: true,
    }).then((outcome) => {
      if (outcome.status === 'upgraded') {
        toast({
          variant: 'success',
          title: `${environmentName} is now end-to-end encrypted`,
          description:
            'It was empty, so it was upgraded as you opened it. Its key was made in this browser.',
        });
        latestUpgraded.current();
        return;
      }
      automaticFailures.add(key);
      setAutomatic(nothingChanged(outcome.error) ? 'failed' : 'unconfirmed');
    });
  }, [
    automaticRunning,
    key,
    preview,
    vault,
    orgId,
    orgSlug,
    projectId,
    envSlug,
    environmentName,
    toast,
  ]);

  if (
    placement === 'banner' &&
    (!canManage || previewFailed || preview === null || preview.details === null)
  ) {
    return null;
  }

  if (automaticRunning) {
    return (
      <Alert tone="info" title="Upgrading to end-to-end encryption">
        <p className="flex items-center gap-2">
          <Spinner className="size-4" />
          This environment is empty, so it is being upgraded now, in this browser.
        </p>
      </Alert>
    );
  }

  const blockedReason =
    preview === null || preview.canUpgrade
      ? null
      : blockerSentence(preview.reasons, preview.details);
  const details = preview?.details ?? null;

  return (
    <Alert
      tone={placement === 'banner' ? 'warning' : 'info'}
      title="This environment uses server-side encryption"
    >
      <p>
        It was created before end-to-end encryption, so its values are encrypted under a key
        xecret&apos;s servers can unwrap — we could read them.{' '}
        {canManage
          ? 'Upgrade it in place: its values, notes and history are re-encrypted in this browser under a new key the server never sees, and it keeps its name, its access and its settings.'
          : 'An owner or an admin of this environment can upgrade it to end-to-end encryption in place.'}
      </p>

      {canManage && preview !== null && details === null && blockedReason !== null ? (
        // The session thought this member could manage the environment; the
        // server, which knows their grants and custom role, says otherwise.
        <p className="text-fg-subtle mt-2 text-sm">{blockedReason}</p>
      ) : null}

      {canManage && preview !== null && details !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant={placement === 'banner' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              // Each open re-reads what the upgrade would do, so the dialog
              // never shows a token list from an hour ago.
              setAttempt((current) => current + 1);
              setDialogOpen(true);
            }}
            disabled={!preview.canUpgrade || vault === null || orgId === null}
          >
            Upgrade to end-to-end encryption
          </Button>
          {blockedReason !== null ? (
            <span className="text-fg-subtle text-sm">{blockedReason}</span>
          ) : automatic === 'failed' ? (
            <span className="text-fg-subtle text-sm">
              The automatic upgrade did not finish. Nothing changed — upgrade it from here.
            </span>
          ) : automatic === 'unconfirmed' ? (
            <span className="text-fg-subtle text-sm">
              The automatic upgrade was sent and its answer was lost. Reload the page to see whether
              it landed before starting it again.
            </span>
          ) : null}
        </div>
      ) : null}

      {preview !== null && details !== null && orgId !== null ? (
        <EncryptionUpgradeDialog
          target={target}
          orgId={orgId}
          environmentName={environmentName}
          isProduction={isProduction}
          preview={preview}
          details={details}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onUpgraded={() => {
            setDialogOpen(false);
            latestUpgraded.current();
          }}
        />
      ) : null}
    </Alert>
  );
}

/** Why the button is disabled, in one sentence, from the server's stable reasons. */
function blockerSentence(
  reasons: readonly UpgradeBlocker[],
  details: UpgradeDetails | null,
): string {
  if (reasons.includes('not-permitted') || reasons.includes('not-a-person')) {
    return 'Upgrading it takes an admin of this environment.';
  }
  if (reasons.includes('no-vault')) return 'Set up your vault first — the new key is sealed to it.';
  if (reasons.includes('token-revoke')) {
    return `It has ${pluralize(details?.keylessTokens.length ?? 0, 'CI token')} that the upgrade revokes, and only an owner or an admin can revoke tokens.`;
  }
  return 'It cannot be upgraded right now.';
}

const STEP_LABEL: Record<UpgradeStep, string> = {
  reading: 'Reading every value and its history',
  encrypting: 'Generating the new key and re-encrypting in this browser',
  writing: 'Writing the end-to-end encrypted environment',
  sharing: 'Sharing the new key with your teammates',
};

const STEPS: readonly UpgradeStep[] = ['reading', 'encrypting', 'writing', 'sharing'];

interface EncryptionUpgradeDialogProps {
  target: EnvironmentRef;
  orgId: string;
  environmentName: string;
  isProduction: boolean;
  preview: UpgradePreview;
  details: UpgradeDetails;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpgraded: () => void;
}

/**
 * The confirmation: what the upgrade re-encrypts, what it erases, which CI
 * tokens stop working, and what happens afterwards — then the ceremony, with
 * its steps shown, because re-encrypting a long history takes visible time and
 * a spinner cannot tell "working" from "hung".
 */
function EncryptionUpgradeDialog({
  target,
  orgId,
  environmentName,
  isProduction,
  preview,
  details,
  open,
  onOpenChange,
  onUpgraded,
}: EncryptionUpgradeDialogProps) {
  const { toast } = useToast();
  const vault = useVaultKeys();
  const [step, setStep] = useState<UpgradeStep | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const running = step !== null;

  async function run() {
    if (vault === null || running) return;
    setFailure(null);
    setStep('reading');

    const outcome: UpgradeOutcome = await runEncryptionUpgrade({
      target,
      orgId,
      vault,
      preview,
      share: true,
      onProgress: setStep,
    });
    setStep(null);

    if (outcome.status === 'failed') {
      setFailure(outcome.error);
      return;
    }

    const shared = outcome.shared;
    toast({
      variant:
        shared === null || shared.status === 'shared' || shared.status === 'nothing-to-share'
          ? 'success'
          : 'warning',
      title: `${environmentName} is now end-to-end encrypted`,
      description:
        shared === null || shared.status === 'nothing-to-share'
          ? 'Nobody else holds a vault that may read it yet; they get the key once they set one up.'
          : shared.status === 'shared'
            ? `Its new key was shared with ${pluralize(shared.granted, 'teammate')}.`
            : shared.status === 'substituted'
              ? `${pluralize(shared.count, 'teammate')} presented a different public key from the one this browser recorded, so nobody was given the key yet. Share it from the rotation dialog, where fingerprints are shown.`
              : 'Sharing the key with your teammates did not finish. Use “Share the key” on the environment page.',
    });
    onUpgraded();
  }

  const tokenCount = details.keylessTokens.length;
  const deletedCount = details.deletedSecrets.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        // A failure belongs to the attempt that produced it, not to the next open.
        if (!next) setFailure(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          {isProduction ? (
            <Badge tone="production" className="mb-1 self-start">
              Production
            </Badge>
          ) : null}
          <DialogTitle>Upgrade {environmentName} to end-to-end encryption</DialogTitle>
          <DialogDescription>
            A new key is generated in this browser, and every value is re-encrypted under it here
            before anything is sent. Once it is done, xecret&apos;s servers cannot read anything in
            this environment.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
          <ul className="text-fg flex list-disc flex-col gap-1.5 pl-5 text-sm">
            <li>
              {pluralize(details.liveSecretCount, 'secret')} —{' '}
              {pluralize(details.versionCount, 'version')} of history and{' '}
              {pluralize(details.noteCount, 'note')} — re-encrypted and checked in this browser.
              Names, access, policies and settings stay as they are.
            </li>
            <li>
              Afterwards this browser shares the new key with everyone else who may read this
              environment and has a vault. Anybody without one gets it once they set one up.
            </li>
            <li>
              It is one step on the server: if anything fails, nothing changes and the environment
              stays exactly as it is now.
            </li>
          </ul>

          {tokenCount > 0 ? (
            <Alert tone="warning" title={`${pluralize(tokenCount, 'CI token')} will stop working`}>
              <p>
                {tokenCount === 1 ? 'It was' : 'They were'} made for server-side encryption and{' '}
                {tokenCount === 1 ? 'has' : 'have'} no key of {tokenCount === 1 ? 'its' : 'their'}{' '}
                own, so the new key cannot be sealed to {tokenCount === 1 ? 'it' : 'them'}. The
                upgrade revokes {tokenCount === 1 ? 'it' : 'them'}; issue{' '}
                {tokenCount === 1 ? 'a new one' : 'new ones'} afterwards and update your CI.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5">
                {details.keylessTokens.map((token) => (
                  <li key={token.id} className="text-sm">
                    <span className="font-medium">{token.name}</span>{' '}
                    <code className="text-fg-subtle font-mono">{token.tokenPrefix}…</code>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {deletedCount > 0 ? (
            <Alert
              tone="warning"
              title={`${pluralize(deletedCount, 'deleted secret')} will be erased now`}
            >
              <p>
                Deleted secrets are normally kept for thirty days so they can be restored. These
                cannot be re-encrypted, so the upgrade erases them for good, now.
              </p>
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
                {details.deletedSecrets.map((secret) => (
                  <li key={secret.id} className="font-mono text-sm">
                    {secret.name}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {running ? (
            <ol className="border-line bg-canvas-inset flex flex-col gap-2 rounded-lg border px-3.5 py-3">
              {STEPS.map((entry, index) => {
                const current = STEPS.indexOf(step);
                const done = index < current;
                return (
                  <li key={entry} className="flex items-center gap-2.5 text-sm">
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
                      {STEP_LABEL[entry]}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {failure !== null ? (
            <Alert
              tone="danger"
              title={
                nothingChanged(failure)
                  ? 'The environment was not upgraded'
                  : 'It is not known whether the upgrade landed'
              }
            >
              <p>
                {failure instanceof UpgradeRefusedError ? failure.message : errorMessage(failure)}
              </p>
              {nothingChanged(failure) ? (
                <p className="mt-1.5">
                  Nothing changed: the upgrade is written in one transaction, so it lands completely
                  or not at all.
                </p>
              ) : null}
              {isApiError(failure) && failure.requestId ? (
                <p className="mt-1.5 text-sm">
                  Request id: <code className="font-mono select-all">{failure.requestId}</code>
                </p>
              ) : null}
            </Alert>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setFailure(null);
              onOpenChange(false);
            }}
            disabled={running}
          >
            {failure !== null ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={run}
            loading={running}
            disabled={!preview.canUpgrade || vault === null}
          >
            Upgrade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
