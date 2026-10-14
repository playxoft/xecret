'use client';

import { useEffect, useRef, useState } from 'react';

import { DecryptionError, RecoveryCodeError } from '@xecret/core/crypto/client';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { errorMessage } from '@/lib/api';
import { createGeneration } from '@/lib/generation';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from '@/components/ui';
import { CredentialChoice, RECOVERY_CODE_HINT } from './credential-choice';
import type { CredentialMethod } from './credential-choice';
import { describeSkips, listRetainedVaults, recoverRetainedVault } from './retained-vaults';
import type { RecoveryReport, RetainedVault } from './retained-vaults';
import { readRecoveryCode } from './vault-client';
import { useVault } from './vault-keys';

/**
 * Settings → Security: the vaults this account reset in the last seven days,
 * and the way to recover one (P23).
 *
 * Renders nothing while the vault is locked — recovering re-seals the old keys
 * to the current vault, so it needs the current vault open, and the endpoints
 * refuse a locked session — and nothing when there is nothing to recover. So
 * for almost everybody, almost always, this card does not exist.
 *
 * The copy keeps to two facts: recovering brings back *access to the old
 * vault's environments* (it does not bring back the old passphrase), and after
 * the date shown the old vault is deleted for good.
 */
export function RetainedVaultsCard() {
  const vault = useVault();
  const [retained, setRetained] = useState<RetainedVault[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<RetainedVault | null>(null);

  const unlocked = vault.unlocked && vault.keys !== null;

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    listRetainedVaults()
      .then((list) => {
        if (!cancelled) setRetained(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFailure(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  if (!unlocked) return null;
  if (failure !== null) {
    return (
      <Alert tone="danger" title="Could not check for a previous vault">
        {failure}
      </Alert>
    );
  }
  if (retained === null || retained.length === 0) return null;

  return (
    <Card id="previous-vaults" data-settings-section>
      <CardHeader>
        <CardTitle>Recover a previous vault</CardTitle>
        <CardDescription>
          You reset your vault recently. We keep the old one for seven days. If you have found its
          passphrase or one of its recovery codes, you can bring back its environments into your
          current vault. Nothing in xecret can delete it before the date shown; after that, it is
          deleted for good.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {retained.map((entry) => (
          <div
            key={entry.id}
            className="border-border flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-fg font-medium">
                Reset{' '}
                <time dateTime={toIsoString(entry.retainedAt)}>
                  {formatRelativeTime(entry.retainedAt)}
                </time>
              </span>
              <span className="text-fg-muted">
                {pluralize(entry.environmentCount, 'environment')} · recoverable until{' '}
                <time dateTime={toIsoString(entry.retainedUntil)}>
                  {formatAbsoluteTime(entry.retainedUntil)}
                </time>
                {entry.recoveredAt !== null ? ' · recovered' : ''}
              </span>
            </div>
            {/* Offered again after a recovery: one that skipped an environment
                for lost access can be run again if the access comes back
                inside the window. Nothing already held is written twice. */}
            <Button variant="secondary" onClick={() => setRecovering(entry)}>
              {entry.recoveredAt !== null ? 'Recover again' : 'Recover'}
            </Button>
          </div>
        ))}
      </CardContent>

      <RecoverDialog
        entry={recovering}
        onClose={() => setRecovering(null)}
        onRecovered={() => {
          void listRetainedVaults().then(setRetained, () => {});
        }}
      />
    </Card>
  );
}

type Method = CredentialMethod;

function RecoverDialog({
  entry,
  onClose,
  onRecovered,
}: {
  entry: RetainedVault | null;
  onClose: () => void;
  onRecovered: () => void;
}) {
  const vault = useVault();
  const [method, setMethod] = useState<Method>('passphrase');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RecoveryReport | null>(null);
  // A recovery still running when the dialog closes cannot be called back, so
  // its answer is ignored: reopening shows a fresh form, never a stale result.
  const generation = useRef(createGeneration());

  function close() {
    generation.current.end();
    setSecret('');
    setFailure(null);
    setOutcome(null);
    setBusy(false);
    onClose();
  }

  async function recover(event: React.FormEvent) {
    event.preventDefault();
    if (entry === null || busy || vault.keys === null) return;

    let credential: Parameters<typeof recoverRetainedVault>[0]['credential'];
    if (method === 'recovery-code') {
      const read = readRecoveryCode(secret);
      if ('problem' in read) {
        setFailure(read.problem);
        return;
      }
      credential = { kind: 'recovery-code', code: read.code };
    } else {
      if (secret.length === 0) {
        setFailure('Enter the passphrase of the vault you reset.');
        return;
      }
      credential = { kind: 'passphrase', passphrase: secret };
    }

    const current = generation.current.start();
    setBusy(true);
    setFailure(null);
    try {
      const result = await recoverRetainedVault({ id: entry.id, credential, current: vault.keys });
      // Recovered is recovered, closed or not: the list has to say so.
      onRecovered();
      if (!current()) return;
      setSecret('');
      setOutcome(result);
    } catch (cause) {
      if (!current()) return;
      setFailure(describeRecoverFailure(cause, method));
    } finally {
      if (current()) setBusy(false);
    }
  }

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recover your previous vault</DialogTitle>
          <DialogDescription>
            Its environments come back into the vault you use now. Your current passphrase and
            recovery codes stay as they are.
          </DialogDescription>
        </DialogHeader>

        {outcome !== null ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <Alert tone="success" title="Recovered">
                {outcome.restoredEnvironments === 0
                  ? 'There was nothing new to bring back.'
                  : `${pluralize(outcome.restoredEnvironments, 'environment')} brought back into your vault.`}
              </Alert>
              {describeSkips(outcome.skipped).map((line) => (
                <p key={line} className="text-fg-muted text-sm leading-6">
                  {line}
                </p>
              ))}
            </DialogBody>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={recover} noValidate>
            <DialogBody className="flex flex-col gap-4">
              <CredentialChoice
                value={method}
                disabled={busy}
                onChange={(next) => {
                  // A passphrase must not reappear unmasked in the code field.
                  setMethod(next);
                  setSecret('');
                  setFailure(null);
                }}
              />

              {failure !== null ? (
                <Alert tone="danger" title="Not recovered">
                  {failure}
                </Alert>
              ) : null}

              <Field
                label={
                  method === 'passphrase'
                    ? 'Master passphrase of the vault you reset'
                    : 'A recovery code of the vault you reset'
                }
                hint={
                  method === 'passphrase'
                    ? 'It is checked here, in your browser. It is never sent to xecret.'
                    : RECOVERY_CODE_HINT
                }
              >
                <Input
                  type={method === 'passphrase' ? 'password' : 'text'}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  className={method === 'recovery-code' ? 'font-mono' : undefined}
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Recover
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The one sentence a failed recovery deserves. Pure, so the mapping can be tested. */
export function describeRecoverFailure(cause: unknown, method: Method): string {
  if (cause instanceof DecryptionError) {
    return method === 'passphrase'
      ? 'That passphrase did not open the vault you reset. Check for a typo — it is case-sensitive.'
      : 'That recovery code did not open the vault you reset.';
  }
  if (cause instanceof RecoveryCodeError) {
    return 'That recovery code has a typo. Check each character against your Emergency Kit.';
  }
  return errorMessage(cause);
}
