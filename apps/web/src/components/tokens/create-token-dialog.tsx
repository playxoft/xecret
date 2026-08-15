'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  CopyButton,
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
} from '@/components/ui';
import type { ProjectListResponse, ProjectResponse } from '@/components/projects/types';
import type { CreateServiceTokenResponse } from './types';

export interface CreateTokenDialogProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

/**
 * Mints service tokens, then shows them exactly once.
 *
 * The scope pickers are the security control wearing a form: every token is
 * pinned to one project and **one** environment at mint time, and nothing
 * later can widen it. Selecting several environments therefore mints several
 * tokens — one per environment, each individually revocable — rather than one
 * broad credential, which is the difference between rotating a leaked staging
 * token and rotating away production's too. Read-only is the default and the
 * widening to `write` is a choice made here, visibly, not a field somebody
 * forgets.
 *
 * The reveal step is deliberately terminal — closing it discards the values
 * forever, and the dialog says so before it happens, not after.
 */
export function CreateTokenDialog({
  orgSlug,
  open,
  onOpenChange,
  onCreated,
}: CreateTokenDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        <CreateTokenFlow
          orgSlug={orgSlug}
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

interface MintOutcome {
  minted: CreateServiceTokenResponse[];
  /** Environment slugs whose mint failed, in selection order. */
  failed: string[];
}

function CreateTokenFlow({
  orgSlug,
  onOpenChange,
  onSubmittingChange,
  onCreated,
}: {
  orgSlug: string;
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  onCreated: () => void;
}) {
  const projects = useApiResource<ProjectListResponse>(apiPath.projects(orgSlug));

  const [name, setName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [environmentSlugs, setEnvironmentSlugs] = useState<ReadonlySet<string>>(new Set());
  const [accessLevel, setAccessLevel] = useState<'read' | 'write'>('read');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MintOutcome | null>(null);

  // The environment list follows the chosen project.
  const project = useApiResource<ProjectResponse>(
    projectSlug === '' ? null : apiPath.project(orgSlug, projectSlug),
  );

  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  function toggleEnvironment(slug: string, checked: boolean) {
    setEnvironmentSlugs((current) => {
      const next = new Set(current);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (name.trim() === '' || projectSlug === '' || environmentSlugs.size === 0) {
      setFormError('Name the token and choose a project and at least one environment.');
      return;
    }

    setBusy(true);
    setFormError(null);

    // One token per environment, sequentially — each mint is a separate
    // audited act against the mutation rate limit. A mid-batch failure still
    // reveals what was minted: those tokens exist and will never be shown
    // again, so hiding them behind the error would destroy them.
    const minted: CreateServiceTokenResponse[] = [];
    const failed: string[] = [];
    let firstFailure: string | null = null;
    for (const environmentSlug of environmentSlugs) {
      try {
        minted.push(
          await api.post<CreateServiceTokenResponse>(apiPath.serviceTokens(orgSlug), {
            name: name.trim(),
            projectSlug,
            environmentSlug,
            accessLevel,
          }),
        );
      } catch (cause) {
        failed.push(environmentSlug);
        // The first failure's story; later ones are usually the same.
        firstFailure ??= errorMessage(cause);
      }
    }

    setBusy(false);

    if (minted.length === 0) {
      setFormError(firstFailure ?? 'No tokens could be created.');
      return;
    }

    onCreated();
    setOutcome({ minted, failed });
  }

  if (outcome !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {outcome.minted.length === 1 ? 'Copy the token now' : 'Copy the tokens now'}
          </DialogTitle>
          <DialogDescription>
            This is the only time they will be shown. Only a hash is stored — closing this dialog
            discards the values forever; losing one means minting a new token.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {outcome.failed.length > 0 ? (
            <Alert tone="danger" title="Some environments failed">
              No token was created for: {outcome.failed.join(', ')}. The ones below were.
            </Alert>
          ) : null}

          {outcome.minted.map((issued) => (
            <div key={issued.serviceToken.id} className="flex flex-col gap-1">
              <p className="text-fg-muted text-sm font-medium">
                {issued.serviceToken.projectSlug}/{issued.serviceToken.environmentSlug}
              </p>
              <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
                <code className="text-fg min-w-0 flex-1 truncate font-mono text-sm">
                  {issued.token}
                </code>
                <CopyButton
                  value={issued.token}
                  label={`Copy the token for ${issued.serviceToken.environmentSlug}`}
                />
              </div>
            </div>
          ))}

          <p className="text-fg-subtle text-sm">
            Put each one in its pipeline&apos;s secret store as{' '}
            <code className="font-mono">XECRET_TOKEN</code>. Each token reaches its one environment
            and nothing else, and each is revoked on its own.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>New service token</DialogTitle>
        <DialogDescription>
          A CI credential, pinned to exactly one project and environment. Selecting several
          environments mints one token per environment. It acts as itself — never as a person — and
          every read it makes is audited.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Name" hint="Where it lives, e.g. github-actions-deploy.">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="github-actions-deploy"
            maxLength={100}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field label="Project">
          <Select
            value={projectSlug}
            onValueChange={(next) => {
              setProjectSlug(next);
              setEnvironmentSlugs(new Set());
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {(projects.data?.projects ?? []).map((entry) => (
                <SelectItem key={entry.slug} value={entry.slug}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Environments"
          hint="One token per ticked environment, each pinned to that environment alone."
        >
          {projectSlug === '' ? (
            <p className="text-fg-subtle text-sm">Choose a project first.</p>
          ) : (
            <div className="border-line flex flex-col gap-0 rounded-lg border">
              {(project.data?.environments ?? []).map((environment) => (
                <label
                  key={environment.slug}
                  className="border-line-subtle flex cursor-pointer items-center gap-2.5 px-3 py-2 [&:not(:first-child)]:border-t"
                >
                  <Checkbox
                    checked={environmentSlugs.has(environment.slug)}
                    onCheckedChange={(checked) =>
                      toggleEnvironment(environment.slug, checked === true)
                    }
                    aria-label={`Mint a token for ${environment.name}`}
                  />
                  <span className="flex items-center gap-2 text-sm">
                    {environment.name}
                    {environment.isProduction ? <Badge tone="production">Production</Badge> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field
          label="Access"
          hint={
            accessLevel === 'read'
              ? 'Reads secrets. The right level for builds and deploys.'
              : 'Also writes secrets — for pipelines that rotate credentials. Cannot delete.'
          }
        >
          <Select
            value={accessLevel}
            onValueChange={(next) => setAccessLevel(next as 'read' | 'write')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">Read-only</SelectItem>
              <SelectItem value="write">Read &amp; write</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {environmentSlugs.size > 1 ? `Create ${environmentSlugs.size} tokens` : 'Create token'}
        </Button>
      </DialogFooter>
    </form>
  );
}
