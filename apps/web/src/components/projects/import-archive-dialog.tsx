'use client';

import { useRef, useState } from 'react';

import { DecryptionError, RecoveryCodeError } from '@xecret/core/crypto/client';
import { ArchiveFormatError, openArchive, readArchiveFile } from '@xecret/core/vault-archive';
import type {
  OpenedArchive,
  OpenedEnvironment,
  VaultArchiveDocument,
} from '@xecret/core/vault-archive';
import { errorMessage } from '@/lib/api';
import { createGeneration } from '@/lib/generation';
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
  SecretValue,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { argon2idProvider } from '@/components/vault/argon2';
import { CredentialChoice, RECOVERY_CODE_HINT } from '@/components/vault/credential-choice';
import type { CredentialMethod } from '@/components/vault/credential-choice';
import { readRecoveryCode } from '@/components/vault/vault-client';
import { useVaultKeys } from '@/components/vault/vault-keys';
import { policyProblem } from '@/components/policies/policy-checks';
import { useOrgPolicies } from '@/components/policies/secret-policy-context';
import {
  defaultMapping,
  describeTarget,
  importableValues,
  importValues,
  ioForEnvironment,
  mappingProblem,
  summarise,
} from './import-archive';
import type { ArchiveMapping, ProjectEnvironment, TargetState } from './import-archive';
import type { ImportPlanItem } from '@/components/secrets/types';

/**
 * "Import archive", on a project (P23).
 *
 * Four steps, each asking for one thing: the file; the old passphrase or a
 * recovery code, which open it here, in this tab, and are never sent anywhere;
 * where each environment in the archive should go, and what to do with names
 * that already exist; then a preview — every name and value, masked until
 * revealed, per target — and only then the import. The write is the
 * dashboard's ordinary import, environment by environment; `import-archive.ts`
 * explains what that means for end-to-end-encrypted environments, why a
 * server-encrypted one is never a target, and permissions.
 *
 * Opening an archive needs the vault unlocked in this tab — every target is
 * written under a key the vault opens — so a locked tab is told so before the
 * slow open, not after it.
 *
 * Closing the dialog drops everything it opened. The values were in this tab's
 * memory only, as JavaScript strings, which cannot be wiped — closing is what
 * makes them unreachable. A step still running when the dialog closes cannot
 * be cancelled, so it is ignored instead: every step checks, after each await,
 * that the dialog has not been closed since it started, and a reopened dialog
 * never shows what a closed one was opening.
 */

const NOT_IMPORTED = '__none__';

type Step =
  | { kind: 'file' }
  | { kind: 'credential'; doc: VaultArchiveDocument }
  | { kind: 'map'; archive: OpenedArchive }
  | { kind: 'done'; archive: OpenedArchive; results: TargetResult[] };

/** What the dialog is waiting for: each has its own spinner, and only its own. */
type Busy = 'reading' | 'opening' | 'checking' | 'previewing' | 'importing' | null;

interface TargetResult {
  environmentId: string;
  target: string;
  status: 'imported' | 'previewed' | 'failed';
  message: string;
  /** For a preview: what the import would do with each name. */
  plan?: Readonly<Record<string, ImportPlanItem['status']>>;
}

interface Target {
  slug: string;
  name: string;
  state: TargetState;
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
  const vaultKeys = useVaultKeys();
  const locked = vaultKeys === null;
  // The organisation's secret policy (P19 §8). An archive import writes every
  // value in it anew, so each is held to the value rules before it is
  // encrypted — `null` while loading or unreadable, which refuses nothing.
  const policies = useOrgPolicies(props.orgSlug);
  const secretPolicy = policies.data?.secrets ?? null;
  const [step, setStep] = useState<Step>({ kind: 'file' });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [method, setMethod] = useState<CredentialMethod>('passphrase');
  const [secret, setSecret] = useState('');
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [mapping, setMapping] = useState<ArchiveMapping>({});
  const [strategy, setStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [preview, setPreview] = useState<TargetResult[] | null>(null);
  // Bumped to remount the file input, which is the only way to clear what a
  // file input holds — so the same file can be picked again after an error.
  const [fileInput, setFileInput] = useState(0);
  const generation = useRef(createGeneration());

  function reset() {
    generation.current.end();
    setStep({ kind: 'file' });
    setFailure(null);
    setBusy(null);
    setSecret('');
    setTargets(null);
    setMapping({});
    setStrategy('skip');
    setPreview(null);
    setFileInput((n) => n + 1);
  }

  function onOpenChange(open: boolean) {
    if (!open) reset();
    props.onOpenChange(open);
  }

  async function chooseFile(file: File | undefined) {
    if (file === undefined || busy !== null) return;
    const current = generation.current.start();
    setFailure(null);
    setBusy('reading');
    try {
      const doc = await readArchiveFile(new Uint8Array(await file.arrayBuffer()));
      if (!current()) return;
      setStep({ kind: 'credential', doc });
    } catch (cause) {
      if (!current()) return;
      setFailure(cause instanceof ArchiveFormatError ? cause.message : errorMessage(cause));
      setFileInput((n) => n + 1);
    } finally {
      if (current()) setBusy(null);
    }
  }

  async function open(event: React.FormEvent) {
    event.preventDefault();
    if (step.kind !== 'credential' || busy !== null || locked) return;

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

    const current = generation.current.start();
    setBusy('opening');
    setFailure(null);
    let archive: OpenedArchive;
    try {
      archive = await openArchive(step.doc, credential, { argon2id: argon2idProvider });
    } catch (cause) {
      if (!current()) return;
      setFailure(describeOpenFailure(cause, method));
      setBusy(null);
      return;
    }
    // Closed while Argon2 ran: the opened archive goes nowhere.
    if (!current()) return;
    setSecret('');

    // Every environment of this project, as a target: its mode, and whether
    // this account can write to it now. Asked once, so the mapping can say
    // which targets are offered and why the others are not.
    setBusy('checking');
    setStep({ kind: 'map', archive });
    const surveyed: Target[] = [];
    for (const environment of props.environments) {
      surveyed.push({
        slug: environment.slug,
        name: environment.name,
        state: await ioForEnvironment({
          orgSlug: props.orgSlug,
          orgId: props.orgId,
          projectSlug: props.projectSlug,
          envSlug: environment.slug,
        }),
      });
      if (!current()) return;
    }
    setTargets(surveyed);
    setMapping(defaultMapping(archive, surveyed));
    setBusy(null);
  }

  async function run(dryRun: boolean) {
    if (step.kind !== 'map' || busy !== null) return;
    const problem = mappingProblem(mapping);
    if (problem !== null) {
      setFailure(problem);
      return;
    }

    const current = generation.current.start();
    setBusy(dryRun ? 'previewing' : 'importing');
    setFailure(null);
    const results: TargetResult[] = [];
    let wrote = false;

    for (const environment of step.archive.environments) {
      const target = mapping[environment.environmentId] ?? null;
      if (target === null) continue;

      try {
        // Asked again rather than reused from the survey: a key rotated or a
        // grant revoked since then must be the import's answer too.
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
            message: describeTarget(io),
          });
          continue;
        }

        const targetIsProduction =
          props.environments.find((entry) => entry.slug === target)?.isProduction ?? false;
        const plan = await importValues({
          io: io.io,
          values: importableValues(environment),
          strategy,
          dryRun,
          checkPolicy: (entry) =>
            policyProblem(secretPolicy, {
              name: entry.name,
              newName: entry.newName,
              value: entry.value,
              valueType: 'string',
              isProduction: targetIsProduction,
            }),
        });
        const written = plan.counts.create + plan.counts.overwrite;
        if (!dryRun && written > 0) wrote = true;
        results.push({
          environmentId: environment.environmentId,
          target,
          status: dryRun ? 'previewed' : 'imported',
          message: `${pluralize(plan.counts.create, 'new secret')}, ${pluralize(plan.counts.overwrite, 'overwrite')}, ${pluralize(plan.counts.skip + plan.counts.unchanged, 'unchanged or skipped secret')}`,
          plan: Object.fromEntries(plan.items.map((item) => [item.name, item.status])),
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

    // Written is written, closed or not: the project's listing has to show it.
    if (!dryRun && wrote) props.onImported();
    if (!current()) return;
    setBusy(null);
    if (dryRun) {
      setPreview(results);
    } else {
      setStep({ kind: 'done', archive: step.archive, results });
    }
  }

  const nameOf = (slug: string) =>
    props.environments.find((environment) => environment.slug === slug)?.name ?? slug;

  // Import is offered only once a preview for exactly this mapping and this
  // strategy has shown every name and value it would write.
  const previewed = preview !== null && preview.some((result) => result.status === 'previewed');

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

        {locked && step.kind !== 'done' ? (
          <div className="px-5 pt-4">
            <Alert tone="warning" title="Unlock your vault first">
              Each value is encrypted here, under its environment’s key, before it is sent — and
              your vault is what opens those keys.
            </Alert>
          </div>
        ) : null}

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
              hint={
                busy === 'reading'
                  ? 'Reading the file…'
                  : 'The .zip attached to the email, or the archive.json inside it.'
              }
            >
              <Input
                key={fileInput}
                type="file"
                accept=".zip,.json,application/zip,application/json"
                disabled={busy !== null}
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
              <CredentialChoice
                value={method}
                disabled={busy !== null}
                onChange={(next) => {
                  // A passphrase must not reappear unmasked in the code field.
                  setMethod(next);
                  setSecret('');
                  setFailure(null);
                }}
              />
              <Field
                label={
                  method === 'passphrase'
                    ? 'Master passphrase of the vault that was reset'
                    : 'A recovery code of the vault that was reset'
                }
                hint={
                  method === 'passphrase'
                    ? 'Opening takes a few seconds. It is checked here, never sent.'
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
              <Button type="button" variant="ghost" onClick={reset} disabled={busy !== null}>
                Choose another file
              </Button>
              <Button
                type="submit"
                loading={busy === 'opening'}
                disabled={secret.length === 0 || locked}
              >
                Open archive
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step.kind === 'map' ? (
          <>
            <DialogBody className="flex flex-col gap-4">
              {busy === 'checking' || targets === null ? (
                <p role="status" className="text-fg-muted text-sm">
                  Checking this project’s environments…
                </p>
              ) : (
                <>
                  <TargetList targets={targets} />
                  {step.archive.environments.length === 0 ? (
                    <p className="text-fg-muted text-sm">This archive holds no environments.</p>
                  ) : null}
                  {step.archive.environments.map((environment) => (
                    <ArchiveEnvironmentCard
                      key={environment.environmentId}
                      environment={environment}
                      targets={targets}
                      target={mapping[environment.environmentId] ?? null}
                      preview={
                        preview?.find(
                          (result) => result.environmentId === environment.environmentId,
                        ) ?? null
                      }
                      disabled={busy !== null}
                      onTarget={(slug) => {
                        setPreview(null);
                        setMapping((current) => ({
                          ...current,
                          [environment.environmentId]: slug,
                        }));
                      }}
                    />
                  ))}

                  <Field label="When a secret with the same name already exists">
                    <Select
                      value={strategy}
                      disabled={busy !== null}
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
                        <SelectItem value="overwrite">
                          Replace it with the archive’s value
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <p className="text-fg-subtle text-xs leading-5">
                    Values only: notes and value types are not imported.
                    {previewed
                      ? null
                      : ' Preview first: it shows every name and value it would write.'}
                  </p>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                loading={busy === 'previewing'}
                disabled={busy !== null || targets === null || locked}
                onClick={() => void run(true)}
              >
                Preview
              </Button>
              <Button
                type="button"
                loading={busy === 'importing'}
                disabled={busy !== null || !previewed || locked}
                onClick={() => void run(false)}
              >
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

/** Short words for a target's mode, inside a select item. */
function targetMode(state: TargetState): string {
  if (state.status === 'ready') return 'end-to-end encrypted';
  switch (state.reason) {
    case 'server-mode':
      return 'server-encrypted, not offered';
    case 'downgraded':
      return 'encryption mode changed, not offered';
    default:
      return 'end-to-end encrypted, key unavailable';
  }
}

/** This project's environments: each one's mode, and why one cannot take the import. */
export function TargetList({ targets }: { targets: readonly Target[] }) {
  if (targets.every((target) => target.state.status === 'ready')) return null;
  return (
    <div className="border-line bg-canvas-inset flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <p className="text-fg font-medium">Environments in this project</p>
      <ul className="flex flex-col gap-1.5">
        {targets.map((target) => (
          <li key={target.slug} className="text-fg-muted leading-6">
            <span className="text-fg">{target.name}</span> — {targetMode(target.state)}
            {target.state.status === 'unavailable' ? (
              <span className="block text-xs leading-5">{describeTarget(target.state)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One environment of the archive: where it goes, and — once previewed — what it would write. */
export function ArchiveEnvironmentCard({
  environment,
  targets,
  target,
  preview,
  disabled,
  onTarget,
}: {
  environment: OpenedEnvironment;
  targets: readonly Target[];
  target: string | null;
  preview: TargetResult | null;
  disabled: boolean;
  onTarget: (slug: string | null) => void;
}) {
  const summary = summarise(environment);
  // The environment this one came from, when it is in this project and cannot
  // take the import: said here, so its absence from the default is explained.
  const origin = targets.find(
    (candidate) => candidate.state.environmentId === environment.environmentId,
  );
  const values = importableValues(environment);

  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
      <div className="text-sm">
        <span className="text-fg font-medium">
          {environment.orgName} / {environment.projectName} / {environment.environmentName}
        </span>
        <span className="text-fg-muted">
          {' '}
          — {pluralize(summary.importable, 'secret')} to import
          {summary.noKey + summary.damaged > 0
            ? `, ${summary.noKey + summary.damaged} that did not open`
            : ''}
        </span>
      </div>
      {origin !== undefined && origin.state.status === 'unavailable' ? (
        <p className="text-warning-text text-sm leading-6">
          Its environment here, {origin.name}: {describeTarget(origin.state)}
        </p>
      ) : null}
      <Select
        value={target ?? NOT_IMPORTED}
        disabled={disabled}
        onValueChange={(value) => onTarget(value === NOT_IMPORTED ? null : value)}
      >
        <SelectTrigger aria-label={`Import ${environment.environmentName} into`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_IMPORTED}>Don’t import</SelectItem>
          {targets.map((candidate) => (
            <SelectItem
              key={candidate.slug}
              value={candidate.slug}
              disabled={candidate.state.status !== 'ready'}
            >
              Into {candidate.name} · {targetMode(candidate.state)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preview !== null ? (
        <div className="flex flex-col gap-2">
          <p
            className={
              preview.status === 'failed' ? 'text-danger-text text-sm' : 'text-fg-muted text-sm'
            }
          >
            {preview.status === 'failed' ? 'Cannot import: ' : 'Would import: '}
            {preview.message}
          </p>
          {preview.status === 'previewed' ? (
            <ul
              className="flex flex-col gap-1.5"
              aria-label={`Values for ${environment.environmentName}`}
            >
              {Object.entries(values).map(([name, value]) => {
                const written = willWrite(preview.plan?.[name]);
                return (
                  <li
                    key={name}
                    className={`grid grid-cols-[minmax(0,14rem)_1fr] items-center gap-3 ${written ? '' : 'opacity-60'}`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-fg truncate font-mono text-xs">{name}</span>
                      <span className="text-fg-subtle text-xs">
                        {describePlanStatus(preview.plan?.[name])}
                      </span>
                    </span>
                    <SecretValue name={name} onReveal={async () => value} />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Whether the import would write this name's value. */
function willWrite(status: ImportPlanItem['status'] | undefined): boolean {
  return status === 'create' || status === 'overwrite';
}

/** What the import would do with one name, for the preview list. */
export function describePlanStatus(status: ImportPlanItem['status'] | undefined): string {
  switch (status) {
    case 'create':
      return 'new';
    case 'overwrite':
      return 'replaces the current value';
    case 'skip':
      return 'not written — the current value is kept';
    case 'unchanged':
      return 'not written — already this value';
    case undefined:
      return 'not in the plan';
    default:
      return 'not written';
  }
}

/** Why the archive did not open, in one sentence. Pure, so the mapping can be tested. */
export function describeOpenFailure(cause: unknown, method: CredentialMethod): string {
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
