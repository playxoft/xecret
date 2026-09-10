'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { OrgRole } from '@xecret/core/authz';
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
  PlusIcon,
  Textarea,
  UsersIcon,
  useToast,
} from '@/components/ui';
import { ProjectMembersDialog } from '@/components/members/project-members-dialog';
import type { Environment, Project } from './types';

export interface ProjectActionsProps {
  orgSlug: string;
  project: Project;
  environments: readonly Environment[];
  /** Hidden for roles that certainly cannot use it. The server still decides. */
  canManage: boolean;
  /**
   * The viewer's organisation role, which bounds whose grants the members
   * dialog lets them touch — nobody manages a role above their own, and the
   * server refuses it either way.
   */
  viewerRole: OrgRole;
  onChanged: () => void;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Members, rename and delete, for a project.
 *
 * There is no `/app/{org}/{project}/settings` route — a project has two editable
 * fields and a delete, which is a menu, not a page. All of it lives here so the
 * overview screen stays a description of the project rather than a form.
 *
 * The two member items are first and separated from the other two, because
 * they are what somebody opens on purpose rather than what they reach while
 * tidying up: "who can read this project's production?" is asked far more
 * often than a project is renamed, and a menu that buries it under Rename
 * teaches people to go to the Members page and open every member in turn
 * instead.
 *
 * "Invite" is a link out to the organisation's Members page rather than a
 * dialog raised here. Inviting is an *organisation* act — a seat, a role, an
 * email — that happens to be wanted while looking at a project, and the page
 * it lands on is where the invitation, the seat count and the pending list all
 * already live. Sending someone there beats mounting a third copy of the
 * invite dialog behind a project's menu.
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
  viewerRole,
  onChanged,
}: ProjectActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [managingMembers, setManagingMembers] = useState(false);
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
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem onSelect={() => setManagingMembers(true)}>
            <UsersIcon className="size-4" />
            Members…
          </DropdownMenuItem>
          {/* Marked out from the items around it: everything else in this menu
              changes the project in place, and this one leaves the page. The
              accent is the same one the sidebar uses for "you are here", which
              is the only colour in the design system that means "this is the
              live thing" rather than "this is dangerous". */}
          <DropdownMenuItem asChild>
            <Link href={appPath.members(orgSlug)} className="text-accent-text">
              <PlusIcon className="size-4" />
              Invite a member
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename project…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
            Delete project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectMembersDialog
        orgSlug={orgSlug}
        projectSlug={project.slug}
        projectName={project.name}
        viewerRole={viewerRole}
        open={managingMembers}
        onOpenChange={setManagingMembers}
      />

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
