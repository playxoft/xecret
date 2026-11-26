'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, isApiError } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import { canAdminister } from '@/app/(dashboard)/_components/session';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
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
import { ImportArchiveDialog } from './import-archive-dialog';
import type { Environment, Project } from './types';

export interface ProjectActionsProps {
  orgSlug: string;
  project: Project;
  environments: readonly Environment[];
  /**
   * The viewer's membership. Its authority decides which items are drawn —
   * each hidden where it certainly cannot succeed, the server still deciding —
   * and bounds whose grants the members dialog lets them touch.
   */
  organization: SessionOrganization;
  /** After a rename, or an archive import that wrote anything. */
  onChanged: () => void;
}

/**
 * The server's bounds on a project's name and description
 * (`NAME_MAX_LENGTH` / `DESCRIPTION_MAX_LENGTH` in `server/schemas/resources.ts`).
 *
 * Written again rather than imported, because that module is the server's: it
 * pulls zod, the plan table and the repository constants into whatever imports
 * it, and a client bundle has no business carrying them for two numbers. The
 * test beside this file pins each to the server's, so the textarea cannot
 * stop short of what the API accepts, or let somebody type past it and learn
 * so only from a refusal.
 */
export const NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * What a description field sends: the text trimmed, or `null` for none.
 *
 * `null` rather than `''`, because the column is nullable and the schema
 * accepts `null` as "clear it" — an empty string would be stored as a
 * description of nothing, and every screen that asks "has this project got a
 * description?" would have to know that `''` also means no.
 */
export function descriptionToSend(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Which of the menu's items to draw for the viewer — each hidden where it
 * certainly cannot succeed, the server still deciding. Pure, so the gating can
 * be tested without opening a menu that only renders into a portal.
 *
 * One item per capability, so an admin whose custom role withholds one of
 * them loses that item rather than the whole menu — and the menu is drawn
 * whenever any one of them is left, an inviter with nothing else included.
 * The Invite item only links to the Members page, so it needs no role to
 * invite at here; that page is the one that explains when there is none.
 *
 * Import archive is the one item that is not an administrator's: it writes
 * secrets, and a developer may do that. So it asks what the import asks of
 * every target, and not `canAdminister`, which would hide it from every
 * developer. That is three actions, not two: the import request itself
 * authorises `secret.create` and `secret.update`, both, up front
 * (`…/import/route.ts`), but before it is sent the dialog reads each target's
 * key state (`…/keys/route.ts`) and the complete listing the plan is built
 * against (`…/secrets/route.ts`), and both of those ask `secret.read`. `can()`
 * refuses a member without any one of the three before a grant is consulted, so
 * a viewer, or a custom role without one, could never complete it; a
 * per-environment refusal — production, typically — is the dialog's to report.
 * And it needs an environment to import into.
 *
 * Rename and Edit description are one permission seen twice: both are
 * `PATCH …/projects/{slug}`, which authorises `project.update` and nothing
 * else, so the two flags are read off the same decision and can never be
 * offered apart.
 */
export function projectMenuItems(
  organization: SessionOrganization,
  environments: readonly Environment[],
) {
  const { capabilities } = organization.authority;
  const canUpdate = canAdminister(organization, 'project.update');
  return {
    canManageMembers: canAdminister(organization, 'member.update'),
    canInvite: canAdminister(organization, 'member.invite'),
    canImportArchive:
      environments.length > 0 &&
      capabilities.includes('secret.read') &&
      capabilities.includes('secret.create') &&
      capabilities.includes('secret.update'),
    canRename: canUpdate,
    canEditDescription: canUpdate,
    canDelete: canAdminister(organization, 'project.delete'),
  };
}

/**
 * Members, archive import, rename, description and delete, for a project.
 *
 * There is no `/app/{org}/{project}/settings` route — a project has two editable
 * fields and a delete, which is a menu, not a page. All of it lives here so the
 * overview screen stays a description of the project rather than a form.
 *
 * The description has an item of its own as well as a field in Rename. Looking
 * for "where do I change what this project says about itself?" nobody reads
 * "Rename project" as the answer, so the field sat one dialog away from every
 * person who wanted it. Rename keeps it too: somebody renaming a project is the
 * person most likely to notice the sentence under the name is now wrong.
 *
 * The two member items are first and separated from the rest, because
 * they are what somebody opens on purpose rather than what they reach while
 * tidying up: "who can read this project's production?" is asked far more
 * often than a project is renamed, and a menu that buries it under Rename
 * teaches people to go to the Members page and open every member in turn
 * instead.
 *
 * "Import archive" keeps those exact words: the email that carries a vault's
 * archive (`server/vault-archive-mail.ts`) tells its reader to open a project
 * and choose it in this menu, and the README inside archives already issued
 * names it without the menu.
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
  organization,
  onChanged,
}: ProjectActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [managingMembers, setManagingMembers] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const {
    canManageMembers,
    canInvite,
    canImportArchive,
    canRename,
    canEditDescription,
    canDelete,
  } = projectMenuItems(organization, environments);
  const editsInPlace = canImportArchive || canRename || canEditDescription;
  const hasItems = canManageMembers || canInvite || editsInPlace || canDelete;
  // An import already open outlives the flags that offered it — see the
  // dialog's mount below — so it holds this component up even with no menu.
  if (!hasItems && !importing) return null;

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
      {hasItems ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" aria-label={`Manage ${project.name}`}>
              Manage
              <ChevronDownIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            {canManageMembers ? (
              <DropdownMenuItem onSelect={() => setManagingMembers(true)}>
                <UsersIcon className="size-4" />
                Members…
              </DropdownMenuItem>
            ) : null}
            {/* Marked out from the items around it: everything else in this menu
                changes the project in place, and this one leaves the page. The
                accent is the same one the sidebar uses for "you are here", which
                is the only colour in the design system that means "this is the
                live thing" rather than "this is dangerous". */}
            {canInvite ? (
              <DropdownMenuItem asChild>
                <Link href={appPath.members(orgSlug)} className="text-accent-text">
                  <PlusIcon className="size-4" />
                  Invite a member
                </Link>
              </DropdownMenuItem>
            ) : null}
            {/* Import archive, Rename and Edit description share a group: all
                three act on the project in place, none is about who can reach
                it. The description sits directly under Rename, beside the
                other half of what the project says about itself. */}
            {editsInPlace ? (
              <>
                {canManageMembers || canInvite ? <DropdownMenuSeparator /> : null}
                {canImportArchive ? (
                  <DropdownMenuItem onSelect={() => setImporting(true)}>
                    Import archive…
                  </DropdownMenuItem>
                ) : null}
                {canRename ? (
                  <DropdownMenuItem onSelect={() => setRenaming(true)}>
                    Rename project…
                  </DropdownMenuItem>
                ) : null}
                {canEditDescription ? (
                  <DropdownMenuItem onSelect={() => setEditingDescription(true)}>
                    Edit description…
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : null}
            {canDelete ? (
              <>
                {canManageMembers || canInvite || editsInPlace ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
                  Delete project…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <ProjectMembersDialog
        orgSlug={orgSlug}
        projectSlug={project.slug}
        projectName={project.name}
        assignableRoles={organization.authority.assignableRoles}
        open={managingMembers}
        onOpenChange={setManagingMembers}
      />

      {/* Mounted while the item is offered, and for as long as the dialog is
          open whether it is still offered or not. The flag can flip under an
          open dialog — the session's role re-read, the environments reloaded —
          and unmounting it then threw away the archive it had opened, after
          which `importing`, still true, mounted a fresh, empty one in its
          place. The item stays gated by the flag; closing clears `importing`. */}
      {canImportArchive || importing ? (
        <ImportArchiveDialog
          open={importing}
          onOpenChange={setImporting}
          orgSlug={orgSlug}
          orgId={organization.id}
          projectSlug={project.slug}
          environments={environments}
          onImported={onChanged}
        />
      ) : null}

      <RenameProjectDialog
        orgSlug={orgSlug}
        project={project}
        open={renaming}
        onOpenChange={setRenaming}
        onSaved={onChanged}
      />

      <EditDescriptionDialog
        orgSlug={orgSlug}
        project={project}
        open={editingDescription}
        onOpenChange={setEditingDescription}
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

export interface ProjectFormProps {
  orgSlug: string;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** A project `PATCH` body: any subset of the two fields a person can edit. */
export interface ProjectPatch {
  name?: string;
  description?: string | null;
}

/**
 * What the rename dialog sends: the fields that differ from the project as the
 * dialog read it, and nothing else.
 *
 * Compared the way they are sent — the name trimmed, the description trimmed
 * with an empty box meaning none — so a trailing space, or a description
 * cleared on a project that never had one, is not a change.
 *
 * ── Why not both fields, always ──
 * Sending the description the dialog was opened with reverted any description
 * saved in the meantime through "Edit description": a rename quietly undid a
 * colleague's sentence. And an unchanged submit still wrote the row, moving
 * `updated_at` and leaving a `project.updated` audit record for an edit nobody
 * made. An empty patch is what disables Save.
 */
export function projectPatch(
  project: Pick<Project, 'name' | 'description'>,
  name: string,
  description: string,
): ProjectPatch {
  const patch: ProjectPatch = {};
  const nextName = name.trim();
  if (nextName !== project.name) patch.name = nextName;
  const nextDescription = descriptionToSend(description);
  if (nextDescription !== descriptionToSend(project.description ?? '')) {
    patch.description = nextDescription;
  }
  return patch;
}

/**
 * The name and the description, together.
 *
 * Exported for its test, which renders it inside a bare `Dialog` root: the
 * dialog's own content goes through a portal, which static markup never draws.
 */
export function RenameProjectForm({ orgSlug, project, onOpenChange, onSaved }: ProjectFormProps) {
  const { toast } = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const patch = projectPatch(project, name, description);
  const unchanged = Object.keys(patch).length === 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || unchanged) return;

    if (name.trim().length === 0) {
      setFieldErrors({ name: 'Enter a project name.' });
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setError(null);

    try {
      await api.patch(apiPath.project(orgSlug, project.slug), patch);
      toast({ variant: 'success', title: 'Project updated' });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setSubmitting(false);
      // A refusal the schema pinned to a field is shown on that field, where
      // it reads as being about what was typed there rather than as a fault.
      const fields = isApiError(cause) ? cause.fieldErrors() : {};
      if (fields['name'] !== undefined || fields['description'] !== undefined) {
        setFieldErrors(fields);
        return;
      }
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
        <Field label="Name" error={fieldErrors['name']}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFieldErrors({});
            }}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <DescriptionField
          value={description}
          onChange={(value) => {
            setDescription(value);
            setFieldErrors({});
          }}
          error={fieldErrors['description']}
        />

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={unchanged}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditDescriptionDialog({
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
        {/* One component down, for the reason the rename dialog gives. */}
        <EditDescriptionForm
          orgSlug={orgSlug}
          project={project}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The description on its own.
 *
 * ── Why it sends only the description ──
 * The name is not in this form, so it is not in the request either. Sending
 * the name the dialog was opened with would be a second, silent rename: a
 * colleague who renamed the project while this was open would have their
 * change reverted by somebody who only meant to fix a sentence. `PATCH` takes
 * any subset of the fields for exactly this reason.
 *
 * ── Why Save waits for a change ──
 * An unchanged description would still write the row, and `updated_at` is what
 * "last modified" reads. Saving nothing should not make a project look edited.
 *
 * Exported for its test; see `RenameProjectForm`.
 */
export function EditDescriptionForm({ orgSlug, project, onOpenChange, onSaved }: ProjectFormProps) {
  const { toast } = useToast();
  const [description, setDescription] = useState(project.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const next = descriptionToSend(description);
  const unchanged = next === descriptionToSend(project.description ?? '');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || unchanged) return;

    setSubmitting(true);
    setFieldError(null);
    setError(null);

    try {
      await api.patch(apiPath.project(orgSlug, project.slug), { description: next });
      toast({
        variant: 'success',
        title: next === null ? 'Description removed' : 'Description saved',
      });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setSubmitting(false);
      const problem = isApiError(cause) ? cause.fieldErrors()['description'] : undefined;
      if (problem !== undefined) {
        setFieldError(problem);
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the description.');
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Edit description</DialogTitle>
        <DialogDescription>
          Shown under the name of <span className="text-fg font-medium">{project.name}</span> on its
          page and in the organisation’s list of projects.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <DescriptionField
          value={description}
          onChange={(value) => {
            setDescription(value);
            setFieldError(null);
          }}
          error={fieldError}
          autoFocus
        />

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        {/* Says what pressing it will do: an emptied box removes the
            description, and a button still reading "Save" over an empty box
            leaves somebody unsure whether nothing or everything is about to go. */}
        <Button type="submit" variant="primary" loading={submitting} disabled={unchanged}>
          {next === null && !unchanged ? 'Remove description' : 'Save description'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The description textarea, as both dialogs draw it — so the limit, the count
 * and the way to clear it read the same in each.
 *
 * The count is of what the box holds, which is what `maxLength` stops at. The
 * server trims before it measures, so a box the textarea let somebody fill is
 * never one the API refuses for length.
 */
function DescriptionField({
  value,
  onChange,
  error,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null | undefined;
  autoFocus?: boolean;
}) {
  return (
    <Field
      label="Description"
      optional
      error={error}
      hint={`${value.length} of ${DESCRIPTION_MAX_LENGTH} characters. Leave it empty to remove the description.`}
    >
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="What this project is, so the next person does not have to guess."
        maxLength={DESCRIPTION_MAX_LENGTH}
        rows={4}
        autoFocus={autoFocus}
      />
    </Field>
  );
}
