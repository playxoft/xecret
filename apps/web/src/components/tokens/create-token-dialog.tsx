'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import {
  Alert,
  Badge,
  Button,
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
 * Mints a service token, then shows it exactly once.
 *
 * The scope pickers are the security control wearing a form: a token is pinned
 * to one project and one environment at mint time, and nothing later can
 * widen it. Read-only is the default and the widening to `write` is a choice
 * made here, visibly, not a field somebody forgets.
 *
 * The reveal step is deliberately terminal — closing it discards the value
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
  const [environmentSlug, setEnvironmentSlug] = useState('');
  const [accessLevel, setAccessLevel] = useState<'read' | 'write'>('read');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<CreateServiceTokenResponse | null>(null);

  // The environment menu follows the chosen project.
  const project = useApiResource<ProjectResponse>(
    projectSlug === '' ? null : apiPath.project(orgSlug, projectSlug),
  );

  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (name.trim() === '' || projectSlug === '' || environmentSlug === '') {
      setFormError('Name the token and choose a project and environment.');
      return;
    }

    setBusy(true);
    setFormError(null);

    try {
      const response = await api.post<CreateServiceTokenResponse>(apiPath.serviceTokens(orgSlug), {
        name: name.trim(),
        projectSlug,
        environmentSlug,
        accessLevel,
      });
      onCreated();
      setIssued(response);
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (issued !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Copy the token now</DialogTitle>
          <DialogDescription>
            This is the only time it will be shown. Only a hash is stored — closing this dialog
            discards the value forever; losing it means minting a new token.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="text-fg min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
              {issued.token}
            </code>
            <CopyButton value={issued.token} label="Copy service token" />
          </div>
          <p className="text-fg-subtle text-xs">
            Put it in your CI provider&apos;s secret store as{' '}
            <code className="font-mono">XECRET_TOKEN</code>. It reaches{' '}
            <span className="font-medium">
              {issued.serviceToken.projectSlug}/{issued.serviceToken.environmentSlug}
            </span>{' '}
            and nothing else.
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
          A CI credential, pinned to exactly one project and environment. It acts as itself — never
          as a person — and every read it makes is audited.
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
              setEnvironmentSlug('');
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

        <Field label="Environment">
          <Select
            value={environmentSlug}
            onValueChange={setEnvironmentSlug}
            disabled={projectSlug === ''}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  projectSlug === '' ? 'Choose a project first' : 'Choose an environment'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(project.data?.environments ?? []).map((environment) => (
                <SelectItem key={environment.slug} value={environment.slug}>
                  <span className="flex items-center gap-2">
                    {environment.name}
                    {environment.isProduction ? <Badge tone="production">Production</Badge> : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          Create token
        </Button>
      </DialogFooter>
    </form>
  );
}
