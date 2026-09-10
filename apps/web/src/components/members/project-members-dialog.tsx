'use client';

import { useState } from 'react';

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProjectMembersPanel({
  orgSlug,
  projectSlug,
  projectName,
  viewerRole,
  onOpenChange,
}: {
  orgSlug: string;
  projectSlug: string;
  projectName: string;
  viewerRole: OrgRole;
  onOpenChange: (open: boolean) => void;
}) {
  const access = useApiResource<ProjectMemberListResponse>(
    apiPath.projectMembers(orgSlug, projectSlug),
  );
  const { toast } = useToast();
  const [error, setError] = useState<unknown>(null);
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
  const assignable = members.filter((member) => !visible.includes(member));
  const dirty = staged.size > 0;

  function shownLevel(memberId: string, environmentSlug: string, server: AccessLevel) {
    return staged.get(`${memberId}/${environmentSlug}`) ?? server;
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
    setError(null);
    try {
      // Sequential: each write is a separate audited mutation, and the upsert
      // is idempotent — a retry after a mid-batch failure re-sends already
      // applied cells harmlessly.
      for (const [cell, level] of staged) {
        const [memberId, environmentSlug] = cell.split('/') as [string, string];
        await api.put(apiPath.memberGrants(orgSlug, memberId), {
          projectSlug,
          environmentSlug,
          accessLevel: level,
        });
      }
      toast({ variant: 'success', title: `Updated access to ${projectName}` });
      // The dialog stays open: the staging empties, the grid re-reads, and
      // what is shown is the server's answer rather than a memory of the form.
      setStaged(new Map());
      access.reload();
    } catch (cause) {
      // The whole batch stays staged: re-saving re-sends everything, and the
      // writes that already landed answer as no-ops.
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Revokes this project for one member: an explicit project-wide no-access,
   * then the deletion of every environment grant that would override it.
   * Immediate and confirmed, unlike the capsules — it is the one act here that
   * removes standing access rather than composing an adjustment.
   */
  async function removeMember(member: ProjectMember) {
    setSaving(true);
    setError(null);
    try {
      await api.put(apiPath.memberGrants(orgSlug, member.id), {
        projectSlug,
        environmentSlug: null,
        accessLevel: 'none',
      });
      for (const grant of member.grants) {
        if (grant.environmentSlug === null) continue;
        await api.delete(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug,
          environmentSlug: grant.environmentSlug,
        });
      }
      toast({
        variant: 'success',
        title: `Removed ${member.displayName ?? member.email} from ${projectName}`,
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
      setError(cause);
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
        {error !== null ? (
          <Alert tone="danger" title="That change was not saved">
            {errorMessage(error)}
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
                        variant="ghost"
                        size="sm"
                        className="text-danger-text hover:text-danger-text"
                        disabled={saving}
                        aria-label={`Remove ${member.displayName ?? member.email} from ${projectName}`}
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
