'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  ChevronDownIcon,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Textarea,
  useToast,
} from '@/components/ui';
import type { Environment, Project } from './types';

export interface ProjectActionsProps {
  orgSlug: string;
  project: Project;
  environments: readonly Environment[];
  /** Hidden for roles that certainly cannot use it. The server still decides. */
  canManage: boolean;
  onChanged: () => void;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Rename and delete, for a project.
 *
 * There is no `/app/{org}/{project}/settings` route — a project has two editable
 * fields and a delete, which is a menu, not a page. Both live here so the
 * overview screen stays a description of the project rather than a form.
 *
 * The controls are hidden when the viewer's organisation role cannot possibly
 * complete them. That is a courtesy and nothing more: every action is authorised
 * server-side by `can()`, and a browser that renders the menu anyway gets a 403.
 */
export function ProjectActions({
  orgSlug,
  project,
  environments,
  canManage,
  onChanged,
}: ProjectActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!canManage) return null;

  const holdsProduction = environments.some((environment) => environment.isProduction);

  async function deleteProject() {
    // The server requires the slug echoed back when the project contains a
    // production environment, and refuses the request otherwise. Sending it
    // whenever it is required — rather than always — keeps the client's rule and
    // the server's rule the same rule.
    await api.delete(
      apiPath.project(orgSlug, project.slug),
      holdsProduction ? { confirm: project.slug } : undefined,
    );

    toast({ variant: 'success', title: `Deleted ${project.name}` });
    router.push(appPath.org(orgSlug));
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" aria-label={`Manage ${project.name}`}>
            Manage
            <ChevronDownIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename project…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
            Delete project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameProjectDialog
        orgSlug={orgSlug}
        project={project}
        open={renaming}
        onOpenChange={setRenaming}
        onSaved={onChanged}
      />

      {/*
        Deleting a project hides every environment and every secret beneath it at
        once, and the applications reading those secrets keep working until their
        next deploy — so the mistake is discovered late, by somebody else, during
        an outage. When production is involved the confirmation demands the slug,
        which is the one step that cannot be completed by muscle memory.

        Two elements rather than a spread of conditional props: `strength` and
        `confirmPhrase` are a discriminated pair, and merging them in only
        sometimes is exactly the shape the union exists to make impossible.
      */}
      {holdsProduction ? (
        <ConfirmDialog
          strength="production"
          confirmPhrase={project.slug}
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${project.name}?`}
          description="This project contains a production environment. Deleting it hides every environment and every secret it holds."
          confirmLabel="Delete project"
          onConfirm={deleteProject}
        >
          <SoftDeleteNote />
        </ConfirmDialog>
      ) : (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${project.name}?`}
          description="This hides the project and every environment and secret it holds."
          confirmLabel="Delete project"
          onConfirm={deleteProject}
        >
          <SoftDeleteNote />
        </ConfirmDialog>
      )}
    </>
  );
}

function SoftDeleteNote() {
  return (
    <Alert tone="info" title="Nothing is destroyed">
      This is a soft delete. The rows are hidden, the environment keys still unwrap them, and the
      audit records that say this project existed keep pointing at it. Restoring it is a support
      request.
    </Alert>
  );
}

function RenameProjectDialog({
  orgSlug,
  project,
  open,
  onOpenChange,
  onSaved,
}: {
  orgSlug: string;
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* One component down, because Radix unmounts a closed dialog's content
            — so the fields are seeded from the current project on every open,
            with no effect re-seeding them a render later. */}
        <RenameProjectForm
          orgSlug={orgSlug}
          project={project}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

function RenameProjectForm({
  orgSlug,
  project,
  onOpenChange,
  onSaved,
}: {
  orgSlug: string;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Enter a project name.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.patch(apiPath.project(orgSlug, project.slug), {
        name: trimmed,
        // `null` clears the description; an empty string would store one.
        description: description.trim().length === 0 ? null : description.trim(),
      });
      toast({ variant: 'success', title: 'Project updated' });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setSubmitting(false);
      setError(cause instanceof Error ? cause.message : 'Could not update the project.');
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>
          The slug stays <code className="text-fg font-mono">{project.slug}</code>. It appears in
          URLs, in <code className="font-mono">.xecret.yaml</code> and in CI configuration, so it
          cannot be changed.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field label="Description" optional>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={DESCRIPTION_MAX_LENGTH}
            rows={3}
          />
        </Field>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}
