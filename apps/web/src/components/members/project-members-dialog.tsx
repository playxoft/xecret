'use client';

import { useEffect, useState } from 'react';

import { canAssignRole } from '@xecret/core/authz';
import type { AccessLevel, OrgRole } from '@xecret/core/authz';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { initials, pluralize } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  ChevronRightIcon,
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
  DropdownMenuTrigger,
  PlusIcon,
  Skeleton,
  useToast,
} from '@/components/ui';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { LevelToggle } from './level-toggle';
import { ROLE_LABELS, ROLE_TONE } from './types';
import type { ProjectMember, ProjectMemberListResponse } from './types';

/**
 * Who can reach this project, managed from the project itself.
 *
 * ── Why the same question has two screens ──
 * The member screen answers "what can this person reach?", one person at a
 * time, and is where somebody joining or leaving is dealt with. This answers
 * the transpose — "who can reach *this*?" — which is the question actually
 * being asked while looking at a project, and which the member screen can only
 * answer by opening every member in turn. Both write the same grant rows
 * through the same audited endpoint; neither is a shortcut around the other.
 *
 * ── The shape of it ──
 * Members holding access are listed, each folding open to this project's
 * environments with the level capsule on every row — the same control, in the
 * same three positions, as the member access panel and the invite dialog.
 * "Add member" reveals somebody who holds nothing yet so a level can be
 * chosen; revealing writes nothing. "Remove" is the one immediate act:
 * confirmed, then a project-wide no-access plus the deletion of every
 * environment grant beneath it, deny first.
 *
 * ── Nothing is written until Save ──
 * Levels are staged locally and applied as one batch, so a rearrangement of
 * who can reach production is a single decision rather than a series of
 * half-applied ones. The dialog stays open afterwards and re-reads, so what is
 * on screen is what is now enforced.
 *
 * Every level shown comes from the server's `resolveAccessLevel` — the same
 * function the authorization engine calls — so the dialog cannot disagree with
 * what a request will experience.
 */

export interface ProjectMembersDialogProps {
  orgSlug: string;
  projectSlug: string;
  projectName: string;
  /** The viewer's organisation role, which bounds whose grants they may touch. */
  viewerRole: OrgRole;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectMembersDialog({
  orgSlug,
  projectSlug,
  projectName,
  viewerRole,
  open,
  onOpenChange,
}: ProjectMembersDialogProps) {
  // Reported up from the panel, because Radix asks *this* component about
  // Escape and the overlay while the two facts that decide the answer — a
  // batch in flight, levels staged — live with the work one component down.
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  function close() {
    setDiscarding(false);
    setDirty(false);
    onOpenChange(false);
  }

  /**
   * Every way out of this dialog, on the same terms.
   *
   * Escape, the overlay and the Close button all arrive here, so none of them
   * can be the one that gets away with throwing staged levels out silently or
   * abandoning a batch halfway through.
   */
  function requestClose(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Mid-batch there is no safe answer to give: the writes still to go would
    // land against a dialog that is no longer there to report or re-read them.
    if (saving) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    close();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        {/* Wider than the default: every row carries a three-segment capsule per
            environment, and squeezing those into `max-w-lg` wraps each one onto
            its own line. */}
        <DialogContent className="max-w-2xl">
          {/* One component down, because Radix unmounts a closed dialog's
              content — so each opening re-reads the grants and starts with an
              empty staging area, with no effect to clear them a render later. */}
          <ProjectMembersPanel
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            projectName={projectName}
            viewerRole={viewerRole}
            onOpenChange={requestClose}
            onSavingChange={setSaving}
            onDirtyChange={setDirty}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discarding}
        onOpenChange={(next) => (next ? undefined : setDiscarding(false))}
        title="Discard these changes?"
        description={`The levels you changed for ${projectName} have not been written yet. Closing now throws them away.`}
        confirmLabel="Discard and close"
        cancelLabel="Keep editing"
        onConfirm={close}
      />
    </>
  );
}

/** A write that did not land, named well enough to act on. */
interface SaveFailure {
  /** Which member, and where — "Ada Lovelace in Production". */
  scope: string;
  /** What the rest of the batch did, when that changes what to do next. */
  note: string | null;
  cause: unknown;
}

function ProjectMembersPanel({
  orgSlug,
  projectSlug,
  projectName,
  viewerRole,
  onOpenChange,
  onSavingChange,
  onDirtyChange,
}: {
  orgSlug: string;
  projectSlug: string;
  projectName: string;
  viewerRole: OrgRole;
  onOpenChange: (open: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const access = useApiResource<ProjectMemberListResponse>(
    apiPath.projectMembers(orgSlug, projectSlug),
  );
  const { toast } = useToast();
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Members revealed by "Add member" but not yet holding anything here. Local
  // only: revealing is not an act the server needs to hear about.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  // The unsaved work: target level per `${memberId}/${environment}`, held only
  // where it differs from what the server said — so `size === 0` *is* "nothing
  // changed", and Save reads straight off it.
  const [staged, setStaged] = useState<ReadonlyMap<string, AccessLevel>>(new Map());
  const [removing, setRemoving] = useState<ProjectMember | null>(null);

  const members = access.data?.members ?? [];
  const environments = access.data?.environments ?? [];

  /** Whether the viewer may edit this member's grants; the server re-checks. */
  const mayEdit = (member: ProjectMember) =>
    !member.isYou && canAssignRole(viewerRole, member.role);

  const visible = members.filter(
    (member) =>
      added.has(member.id) ||
      member.environments.some((environment) => environment.level !== 'none'),
  );
  // Only people whose grants this viewer may actually write. Offering the rest
  // pins a row that every capsule on it is disabled — a dead end that looks
  // like a permission problem with the row rather than with the viewer.
  const assignable = members.filter((member) => !visible.includes(member) && mayEdit(member));
  const dirty = staged.size > 0;

  // The dialog above owns Escape and the overlay, and needs both of these to
  // decide whether closing is allowed.
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  function shownLevel(memberId: string, environmentSlug: string, server: AccessLevel) {
    return staged.get(`${memberId}/${environmentSlug}`) ?? server;
  }

  function memberLabel(member: ProjectMember) {
    return member.displayName ?? member.email;
  }

  /** "Ada Lovelace in Production", for a cell key. */
  function cellScope(memberId: string, environmentSlug: string) {
    const member = members.find((entry) => entry.id === memberId);
    const environment = environments.find((entry) => entry.slug === environmentSlug);
    return `${member === undefined ? 'that member' : memberLabel(member)} in ${environment?.name ?? environmentSlug}`;
  }

  function stageLevel(
    memberId: string,
    environmentSlug: string,
    server: AccessLevel,
    next: AccessLevel,
  ) {
    setStaged((current) => {
      const map = new Map(current);
      const cell = `${memberId}/${environmentSlug}`;
      if (next === server) map.delete(cell);
      else map.set(cell, next);
      return map;
    });
  }

  function toggleExpanded(memberId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setFailure(null);

    // Sequential, and it stops at the first refusal: the batch is one decision
    // about who reaches this project, and pressing on past a write the server
    // would not take composes an arrangement nobody chose.
    const applied = new Set<string>();
    let failed: { cell: string; cause: unknown } | null = null;

    for (const [cell, level] of staged) {
      const [memberId, environmentSlug] = cell.split('/') as [string, string];
      try {
        await api.put(apiPath.memberGrants(orgSlug, memberId), {
          projectSlug,
          environmentSlug,
          accessLevel: level,
        });
        applied.add(cell);
      } catch (cause) {
        failed = { cell, cause };
        break;
      }
    }

    // Whatever landed is enforced access now, not unsaved work — so it leaves
    // the staging area whether the batch finished or not. Keeping it would make
    // a retry re-send writes that are already true and, worse, would leave the
    // grid showing pre-batch levels as though nothing had happened.
    setStaged((current) => {
      const next = new Map(current);
      for (const cell of applied) next.delete(cell);
      return next;
    });
    // Unconditional: after a partial batch the server is the only thing that
    // knows which half of the screen is now stale.
    access.reload();
    setSaving(false);

    if (failed !== null) {
      const [memberId, environmentSlug] = failed.cell.split('/') as [string, string];
      setFailure({
        scope: cellScope(memberId, environmentSlug),
        note:
          applied.size === 0
            ? null
            : `${pluralize(applied.size, 'earlier change')} in this batch did save; the rest were not attempted. The levels below have been re-read.`,
        cause: failed.cause,
      });
      return;
    }

    toast({ variant: 'success', title: `Updated access to ${projectName}` });
  }

  /**
   * Revokes this project for one member: an explicit project-wide no-access,
   * then the deletion of every environment grant that would override it.
   * Immediate and confirmed, unlike the capsules — it is the one act here that
   * removes standing access rather than composing an adjustment.
   */
  async function removeMember(member: ProjectMember) {
    setSaving(true);
    setFailure(null);

    // Named as the calls go out, so a failure says which one stopped rather
    // than that "a change" did not save.
    let scope = `${memberLabel(member)} in ${projectName}`;
    try {
      await api.put(apiPath.memberGrants(orgSlug, member.id), {
        projectSlug,
        environmentSlug: null,
        accessLevel: 'none',
      });
      // Every environment of the project, not only the grants this dialog read
      // when it opened: one written since — by this dialog's own Save, or by
      // somebody else while it was up — would otherwise survive and override
      // the project-wide deny, leaving a "removed" member still holding an
      // environment. Deleting a grant that is not there is a success at the
      // endpoint, so the extra calls cost a round trip and nothing else.
      for (const environment of environments) {
        scope = `${memberLabel(member)} in ${environment.name}`;
        await api.delete(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug,
          environmentSlug: environment.slug,
        });
      }
      toast({
        variant: 'success',
        title: `Removed ${memberLabel(member)} from ${projectName}`,
      });
      setAdded((current) => {
        const next = new Set(current);
        next.delete(member.id);
        return next;
      });
      // Staged levels for a member who was just revoked would be saved on top
      // of the revocation — exactly what the person removing them did not mean.
      setStaged((current) => {
        const next = new Map(current);
        for (const cell of next.keys()) {
          if (cell.startsWith(`${member.id}/`)) next.delete(cell);
        }
        return next;
      });
      access.reload();
    } catch (cause) {
      setFailure({
        scope,
        note: 'Their access to this project may be only partly removed. The levels below have been re-read.',
        cause,
      });
      // The deny may have landed and the deletions not, or the reverse. Either
      // way the screen no longer describes the server.
      access.reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Members of {projectName}</DialogTitle>
        <DialogDescription>
          Access is granted per environment, never per project — “give them the project” quietly
          including production is the accident this model exists to prevent. Roles and membership
          itself are managed on the Members page.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        {failure !== null ? (
          <Alert tone="danger" title={`${failure.scope} was not saved`}>
            {errorMessage(failure.cause)}
            {failure.note === null ? null : ` ${failure.note}`}
          </Alert>
        ) : null}

        {access.error !== null ? (
          <Alert tone="danger" title="The members of this project could not be loaded">
            {errorMessage(access.error)}
          </Alert>
        ) : access.data === null ? (
          <div
            aria-busy="true"
            aria-label="Loading project members"
            className="flex flex-col gap-2"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        ) : environments.length === 0 ? (
          <p className="text-fg-muted text-sm">
            This project has no environments yet, so there is nothing to grant. Create one first.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-fg-subtle text-sm">
                {visible.length === 0
                  ? 'Nobody has been granted access to this project.'
                  : `${pluralize(visible.length, 'member')} with access.`}
              </p>
              {assignable.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="sm">
                      <PlusIcon className="size-4" />
                      Add member
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-64 w-64 overflow-y-auto">
                    {assignable.map((member) => (
                      <DropdownMenuItem
                        key={member.id}
                        onSelect={() => {
                          setAdded((current) => new Set(current).add(member.id));
                          setExpanded((current) => new Set(current).add(member.id));
                        }}
                      >
                        <span className="min-w-0 truncate">
                          {member.displayName ?? member.email}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            {visible.map((member) => {
              const isOpen = expanded.has(member.id);
              const editable = mayEdit(member);
              const granted = member.environments.filter(
                (environment) =>
                  shownLevel(member.id, environment.slug, environment.level) !== 'none',
              ).length;

              return (
                <section
                  key={member.id}
                  className="border-line bg-surface overflow-hidden rounded-lg border"
                >
                  <div className="flex items-center gap-1 py-1 pr-2 pl-1">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(member.id)}
                      aria-expanded={isOpen}
                      className="hover:bg-surface-hover flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
                    >
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn(
                          'text-fg-subtle size-4 shrink-0 transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span
                        aria-hidden="true"
                        className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold"
                      >
                        {initials(member.displayName ?? member.email)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-fg block truncate text-sm font-medium">
                          {member.displayName ?? member.email}
                          {member.isYou ? (
                            <span className="text-fg-subtle font-normal"> · you</span>
                          ) : null}
                        </span>
                        <span className="text-fg-subtle block truncate text-sm">
                          {granted} of {pluralize(member.environments.length, 'environment')}
                        </span>
                      </span>
                      <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>
                        {ROLE_LABELS[member.role]}
                      </Badge>
                    </button>
                    {editable ? (
                      <Button
                        variant="danger-outline"
                        size="sm"
                        disabled={saving}
                        aria-label={`Remove ${memberLabel(member)} from ${projectName}`}
                        onClick={() => setRemoving(member)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>

                  {isOpen
                    ? member.environments.map((environment) => (
                        <div
                          key={environment.slug}
                          className="border-line-subtle flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t px-3 py-2"
                        >
                          <span className="flex items-center gap-2 text-sm">
                            {environment.name}
                            {environment.isProduction ? (
                              <Badge tone="production">Production</Badge>
                            ) : null}
                          </span>
                          <LevelToggle
                            level={shownLevel(member.id, environment.slug, environment.level)}
                            disabled={!editable || saving}
                            scopeLabel={`${member.displayName ?? member.email} in ${environment.name}`}
                            size="sm"
                            onSelect={(next) =>
                              stageLevel(member.id, environment.slug, environment.level, next)
                            }
                          />
                        </div>
                      ))
                    : null}
                </section>
              );
            })}

            <p className="text-fg-subtle text-sm">
              Owners and admins hold admin access everywhere by their role; turning a level off
              writes an explicit “no access” that overrides even a role default.
            </p>

            {access.data.hasMore ? (
              <Alert tone="warning" title="Not everyone is listed">
                This organisation has more members than this dialog loads at once, so somebody with
                access to {projectName} may be missing from the list above. The Members page shows
                all of them, and each one’s access can be managed from there.
              </Alert>
            ) : null}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || saving}
          loading={saving}
        >
          Save changes
        </Button>
      </DialogFooter>

      {removing !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => (next ? undefined : setRemoving(null))}
          title={`Remove ${removing.displayName ?? removing.email} from ${projectName}?`}
          description={`Every environment of ${projectName} becomes “no access” for them. Nothing they created is touched, they stay a member of the organisation, and access can be granted again here at any time.`}
          confirmLabel="Remove access"
          onConfirm={async () => {
            const target = removing;
            setRemoving(null);
            await removeMember(target);
          }}
        />
      ) : null}
    </>
  );
}
