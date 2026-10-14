'use client';

import { useState } from 'react';

import { DecryptionError, RecoveryCodeError } from '@xecret/core/crypto/client';
import { ArchiveFormatError, openArchive, readArchiveFile } from '@xecret/core/vault-archive';
import type { OpenedArchive, VaultArchiveDocument } from '@xecret/core/vault-archive';
import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, pluralize } from '@/lib/format';
import {
  Alert,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { argon2idProvider } from '@/components/vault/argon2';
import { readRecoveryCode } from '@/components/vault/vault-client';
import {
  defaultMapping,
  importableValues,
  importValues,
  ioForEnvironment,
  mappingProblem,
  summarise,
} from './import-archive';
import type { ArchiveMapping, ProjectEnvironment } from './import-archive';

/**
 * "Import archive", on a project (P23).
 *
 * Four steps, each asking for one thing: the file; the old passphrase or a
 * recovery code, which open it here, in this tab, and are never sent anywhere;
 * where each environment in the archive should go, and what to do with names
 * that already exist; then a preview and the import itself. The write is the
 * dashboard's ordinary import, environment by environment — `import-archive.ts`
 * explains what that means for end-to-end-encrypted environments, and for
 * permissions.
 *
 * Closing the dialog drops everything it opened. The values were in this tab's
 * memory only, as JavaScript strings, which cannot be wiped — closing is what
 * makes them unreachable.
 */

const NOT_IMPORTED = '__none__';

type Step =
  | { kind: 'file' }
  | { kind: 'credential'; doc: VaultArchiveDocument }
  | { kind: 'map'; archive: OpenedArchive }
  | { kind: 'done'; archive: OpenedArchive; results: TargetResult[] };

interface TargetResult {
  environmentId: string;
  target: string;
  status: 'imported' | 'previewed' | 'failed';
  message: string;
}

export interface ImportArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  orgId: string;
  projectSlug: string;
  environments: readonly ProjectEnvironment[];
  /** Called after a real (not previewed) import wrote anything. */
  onImported: () => void;
}

export function ImportArchiveDialog(props: ImportArchiveDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'file' });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<'passphrase' | 'recovery-code'>('passphrase');
  const [secret, setSecret] = useState('');
  const [mapping, setMapping] = useState<ArchiveMapping>({});
  const [strategy, setStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [preview, setPreview] = useState<TargetResult[] | null>(null);

  function reset() {
    setStep({ kind: 'file' });
    setFailure(null);
    setBusy(false);
    setSecret('');
    setMapping({});
    setStrategy('skip');
    setPreview(null);
  }

  function onOpenChange(open: boolean) {
    if (!open) reset();
    props.onOpenChange(open);
  }

  async function chooseFile(file: File | undefined) {
    if (file === undefined) return;
    setFailure(null);
    try {
      const doc = await readArchiveFile(new Uint8Array(await file.arrayBuffer()));
      setStep({ kind: 'credential', doc });
    } catch (cause) {
      setFailure(cause instanceof ArchiveFormatError ? cause.message : errorMessage(cause));
    }
  }

  async function open(event: React.FormEvent) {
    event.preventDefault();
    if (step.kind !== 'credential' || busy) return;

    let credential: Parameters<typeof openArchive>[1];
    if (method === 'recovery-code') {
      const read = readRecoveryCode(secret);
      if ('problem' in read) {
        setFailure(read.problem);
        return;
      }
      credential = { kind: 'recovery-code', code: read.code.displayForm };
    } else {
      credential = { kind: 'passphrase', passphrase: secret };
    }

    setBusy(true);
    setFailure(null);
    try {
      const archive = await openArchive(step.doc, credential, { argon2id: argon2idProvider });
      setSecret('');
      setMapping(
        defaultMapping(archive, {
          orgSlug: props.orgSlug,
          projectSlug: props.projectSlug,
          environments: props.environments,
        }),
      );
      setStep({ kind: 'map', archive });
    } catch (cause) {
      setFailure(describeOpenFailure(cause, method));
    } finally {
      setBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    if (step.kind !== 'map' || busy) return;
    const problem = mappingProblem(mapping);
    if (problem !== null) {
      setFailure(problem);
      return;
    }

    setBusy(true);
    setFailure(null);
    const results: TargetResult[] = [];
    let wrote = false;

    for (const environment of step.archive.environments) {
      const target = mapping[environment.environmentId] ?? null;
      if (target === null) continue;

      try {
        const io = await ioForEnvironment({
          orgSlug: props.orgSlug,
          orgId: props.orgId,
          projectSlug: props.projectSlug,
          envSlug: target,
        });
        if (io.status !== 'ready') {
          results.push({
            environmentId: environment.environmentId,
            target,
            status: 'failed',
            message:
              io.reason === 'locked'
                ? 'Unlock your vault, then try again.'
                : io.reason === 'downgraded'
                  ? 'This environment changed its encryption mode since this browser last saw it, so nothing was sent.'
                  : 'You do not hold this environment’s key yet — ask a teammate to share it.',
          });
          continue;
        }

        const plan = await importValues({
          io: io.io,
          values: importableValues(environment),
          strategy,
          dryRun,
        });
        const written = plan.counts.create + plan.counts.overwrite;
        if (!dryRun && written > 0) wrote = true;
        results.push({
          environmentId: environment.environmentId,
          target,
          status: dryRun ? 'previewed' : 'imported',
          message: `${pluralize(plan.counts.create, 'new secret')}, ${pluralize(plan.counts.overwrite, 'overwrite')}, ${pluralize(plan.counts.skip + plan.counts.unchanged, 'unchanged or skipped secret')}`,
        });
      } catch (cause) {
        results.push({
          environmentId: environment.environmentId,
          target,
          status: 'failed',
          message: errorMessage(cause),
        });
      }
    }

    setBusy(false);
    if (dryRun) {
      setPreview(results);
    } else {
      if (wrote) props.onImported();
      setStep({ kind: 'done', archive: step.archive, results });
    }
  }

  const nameOf = (slug: string) =>
    props.environments.find((environment) => environment.slug === slug)?.name ?? slug;

  return (
    <Dialog open={props.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a vault archive</DialogTitle>
          <DialogDescription>
            The archive xecret emailed you when your vault was reset. It is opened here, in your
            browser, with that vault’s passphrase or a recovery code; neither is sent anywhere.
          </DialogDescription>
        </DialogHeader>

        {failure !== null ? (
          <div className="px-5 pt-4">
            <Alert tone="danger" title="Not imported">
              {failure}
            </Alert>
          </div>
        ) : null}

        {step.kind === 'file' ? (
          <DialogBody>
            <Field
              label="Archive file"
              hint="The .zip attached to the email, or the archive.json inside it."
            >
              <Input
                type="file"
                accept=".zip,.json,application/zip,application/json"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </Field>
          </DialogBody>
        ) : null}

        {step.kind === 'credential' ? (
          <form onSubmit={open} noValidate>
            <DialogBody className="flex flex-col gap-4">
              <p className="text-fg-muted text-sm leading-6">
                Made {formatAbsoluteTime(step.doc.createdAt)}
                {step.doc.parts > 1 ? `, part ${step.doc.part} of ${step.doc.parts}` : ''}, holding{' '}
                {pluralize(step.doc.environments.length, 'environment')}.
              </p>
              <Tabs
                value={method}
                onValueChange={(value) => setMethod(value as 'passphrase' | 'recovery-code')}
              >
                <TabsList>
                  <TabsTrigger value="passphrase">Old passphrase</TabsTrigger>
                  <TabsTrigger value="recovery-code">Old recovery code</TabsTrigger>
                </TabsList>
              </Tabs>
              <Field
                label={
                  method === 'passphrase'
                    ? 'Master passphrase of the vault that was reset'
                    : 'A recovery code of the vault that was reset'
                }
                hint="Opening takes a few seconds."
              >
                <Input
                  type={method === 'passphrase' ? 'password' : 'text'}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                Choose another file
              </Button>
              <Button type="submit" loading={busy} disabled={secret.length === 0}>
                Open archive
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step.kind === 'map' ? (
          <>
            <DialogBody className="flex flex-col gap-4">
              {step.archive.environments.length === 0 ? (
                <p className="text-fg-muted text-sm">This archive holds no environments.</p>
              ) : null}
              {step.archive.environments.map((environment) => {
                const summary = summarise(environment);
                return (
                  <div
                    key={environment.environmentId}
                    className="border-border flex flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="text-sm">
                      <span className="text-fg font-medium">
                        {environment.orgName} / {environment.projectName} /{' '}
                        {environment.environmentName}
                      </span>
                      <span className="text-fg-muted">
                        {' '}
                        — {pluralize(summary.importable, 'secret')} to import
                        {summary.noKey + summary.damaged > 0
                          ? `, ${summary.noKey + summary.damaged} that did not open`
                          : ''}
                      </span>
                    </div>
                    <Select
                      value={mapping[environment.environmentId] ?? NOT_IMPORTED}
                      onValueChange={(value) => {
                        setPreview(null);
                        setMapping((current) => ({
                          ...current,
                          [environment.environmentId]: value === NOT_IMPORTED ? null : value,
                        }));
                      }}
                    >
                      <SelectTrigger aria-label={`Import ${environment.environmentName} into`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NOT_IMPORTED}>Don’t import</SelectItem>
                        {props.environments.map((target) => (
                          <SelectItem key={target.slug} value={target.slug}>
                            Into {target.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {preview
                      ?.filter((result) => result.environmentId === environment.environmentId)
                      .map((result) => (
                        <p
                          key={result.target}
                          className={
                            result.status === 'failed'
                              ? 'text-danger-text text-sm'
                              : 'text-fg-muted text-sm'
                          }
                        >
                          {result.status === 'failed' ? 'Cannot import: ' : 'Would import: '}
                          {result.message}
                        </p>
                      ))}
                  </div>
                );
              })}

              <Field label="When a secret with the same name already exists">
                <Select
                  value={strategy}
                  onValueChange={(value) => {
                    setPreview(null);
                    setStrategy(value as 'skip' | 'overwrite');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Keep the existing value</SelectItem>
                    <SelectItem value="overwrite">Replace it with the archive’s value</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <p className="text-fg-subtle text-xs leading-5">
                Values only: notes and value types are not imported.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                loading={busy && preview === null}
                onClick={() => void run(true)}
              >
                Preview
              </Button>
              <Button type="button" loading={busy} onClick={() => void run(false)}>
                Import
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step.kind === 'done' ? (
          <>
            <DialogBody className="flex flex-col gap-2">
              {step.results.map((result) => (
                <Alert
                  key={result.environmentId}
                  tone={result.status === 'failed' ? 'danger' : 'success'}
                  title={`${result.status === 'failed' ? 'Not imported into' : 'Imported into'} ${nameOf(result.target)}`}
                >
                  {result.message}
                </Alert>
              ))}
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Why the archive did not open, in one sentence. Pure, so the mapping can be tested. */
export function describeOpenFailure(
  cause: unknown,
  method: 'passphrase' | 'recovery-code',
): string {
  if (cause instanceof DecryptionError) {
    return method === 'passphrase'
      ? 'That passphrase does not open this archive. It needs the passphrase of the vault that was reset, not your current one.'
      : 'That recovery code does not open this archive. It needs a code of the vault that was reset.';
  }
  if (cause instanceof RecoveryCodeError) {
    return 'That recovery code has a typo. Check each character against your Emergency Kit.';
  }
  if (cause instanceof ArchiveFormatError) return cause.message;
  return errorMessage(cause);
}
