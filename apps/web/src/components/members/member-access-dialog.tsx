'use client';

import { useState } from 'react';

import type { AccessLevel } from '@xecret/core/authz';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ChevronRightIcon,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
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
import { ACCESS_LEVEL_LABELS, ROLE_LABELS, ROLE_TONE } from './types';
import type { EffectiveProject, Member, MemberAccessResponse } from './types';

/**
 * One member's access, in a dialog over the member list.
 *
 * ── The shape of the answer ──
 * Only projects the member can actually reach are listed — a wall of projects
 * they cannot touch says nothing and buries the ones that matter. Each project
 * folds open to its environments, and access is granted **per environment**:
 * there is deliberately no project-wide level control here, because "give them
 * the project" quietly including production is exactly the accident the
 * per-environment model exists to prevent.
 *
 * Each environment offers three levels as checkboxes — Read, Read & write,
 * Admin — of which at most one is ticked. Ticking grants that level; unticking
 * writes an explicit no-access grant rather than deleting the row, so the
 * removal holds even against a role default that would have allowed it.
 *
 * "Add project" only reveals a project so its environments can be ticked; it
 * writes nothing by itself. "Remove" is the inverse in one act: an explicit
 * project-wide no-access plus the deletion of every environment grant.
 *
 * Every level shown comes from the server's `resolveAccessLevel` — the same
 * function the authorization engine calls — re-read after each change, so the
 * dialog can never disagree with what a request will experience.
 */

const GRANTABLE_LEVELS: readonly AccessLevel[] = ['read', 'write', 'admin'];

export function MemberAccessDialog({
  orgSlug,
  member,
  mayEdit,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  member: Member;
  /** Whether the viewer may change grants; the server re-checks every change. */
  mayEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const access = useApiResource<MemberAccessResponse>(
    open ? apiPath.memberAccess(orgSlug, member.id) : null,
  );
  const { toast } = useToast();
  const [error, setError] = useState<unknown>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Projects revealed by "Add project" but not yet holding any grant. Local
  // only: revealing is not an act the server needs to hear about.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<EffectiveProject | null>(null);

  const projects = access.data?.projects ?? [];
  const visible = projects.filter(
    (project) =>
      added.has(project.slug) ||
      project.environments.some((environment) => environment.level !== 'none'),
  );
  const assignable = projects.filter((project) => !visible.includes(project));

  function toggleExpanded(slug: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function revealProject(slug: string) {
    setAdded((current) => new Set(current).add(slug));
    setExpanded((current) => new Set(current).add(slug));
  }

  async function setLevel(projectSlug: string, environmentSlug: string, level: AccessLevel) {
    const cell = `${projectSlug}/${environmentSlug}`;
    setSavingCell(cell);
    setError(null);
    try {
      await api.put(apiPath.memberGrants(orgSlug, member.id), {
        projectSlug,
        environmentSlug,
        accessLevel: level,
      });
      toast({ variant: 'success', title: 'Access updated' });
      access.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setSavingCell(null);
    }
  }

  /**
   * Revokes the whole project: an explicit project-wide no-access, then the
   * deletion of every environment grant that would override it. Sequential —
   * each write is a separate audited mutation, and the order means the deny is
   * in place before any override is removed.
   */
  async function removeProject(project: EffectiveProject) {
    setSavingCell(`${project.slug}/*`);
    setError(null);
    try {
      await api.put(apiPath.memberGrants(orgSlug, member.id), {
        projectSlug: project.slug,
        environmentSlug: null,
        accessLevel: 'none',
      });
      const environmentGrants = (access.data?.grants ?? []).filter(
        (grant) => grant.projectSlug === project.slug && grant.environmentSlug !== null,
      );
      for (const grant of environmentGrants) {
        await api.delete(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug: grant.projectSlug,
          environmentSlug: grant.environmentSlug,
        });
      }
      toast({ variant: 'success', title: `Removed access to ${project.name}` });
      setAdded((current) => {
        const next = new Set(current);
        next.delete(project.slug);
        return next;
      });
      access.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setSavingCell(null);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // A fresh open starts from what the server says, not from what was
          // revealed last time and never granted.
          if (!next) setAdded(new Set());
          onOpenChange(next);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {member.displayName ?? member.email}
              <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>{ROLE_LABELS[member.role]}</Badge>
              {member.status === 'suspended' ? <Badge tone="warning">Suspended</Badge> : null}
            </DialogTitle>
            <DialogDescription>
              Access is granted per environment — a project never grants its environments as one.
              {mayEdit ? ' Tick a level to grant it; untick to leave no access.' : ''}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            {error !== null ? (
              <Alert tone="danger" title="That change was not saved">
                {errorMessage(error)}
              </Alert>
            ) : null}

            {member.status === 'suspended' ? (
              <Alert tone="warning" title="This member is suspended">
                Every request they make is denied. The levels below show what their access will be
                once reinstated.
              </Alert>
            ) : null}

            {access.error !== null ? (
              <Alert tone="danger" title="Their access could not be loaded">
                {errorMessage(access.error)}
              </Alert>
            ) : access.data === null ? (
              <div
                aria-busy="true"
                aria-label="Loading member access"
                className="flex flex-col gap-3"
              >
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} className="h-11 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-fg-subtle text-[0.8125rem]">
                    {visible.length === 0
                      ? 'No project access.'
                      : `Access to ${pluralize(visible.length, 'project')}.`}
                  </p>
                  {mayEdit && assignable.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="secondary" size="sm">
                          <PlusIcon className="size-4" />
                          Add project
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {assignable.map((project) => (
                          <DropdownMenuItem
                            key={project.slug}
                            onSelect={() => revealProject(project.slug)}
                          >
                            {project.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>

                {visible.length === 0 && projects.length === 0 ? (
                  <p className="text-fg-muted text-[0.8125rem]">
                    This organisation has no projects yet, so there is nothing to grant.
                  </p>
                ) : (
                  visible.map((project) => {
                    const isOpen = expanded.has(project.slug);
                    const granted = project.environments.filter(
                      (environment) => environment.level !== 'none',
                    ).length;

                    return (
                      <section
                        key={project.slug}
                        className="border-line overflow-hidden rounded-lg border"
                      >
                        <div className="bg-canvas-inset flex items-center gap-1 py-1 pr-2 pl-1">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(project.slug)}
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
                            <span className="text-fg truncate text-sm font-semibold">
                              {project.name}
                            </span>
                            <span className="text-fg-subtle text-xs whitespace-nowrap">
                              {granted} of {pluralize(project.environments.length, 'environment')}
                            </span>
                          </button>
                          {mayEdit ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger-text hover:text-danger-text"
                              disabled={savingCell !== null}
                              onClick={() => setRemoving(project)}
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>

                        {isOpen
                          ? project.environments.map((environment) => {
                              const cell = `${project.slug}/${environment.slug}`;
                              const saving = savingCell === cell;

                              return (
                                <div
                                  key={environment.slug}
                                  className="border-line-subtle flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t px-3 py-2"
                                >
                                  <span className="flex items-center gap-2 text-[0.8125rem]">
                                    {environment.name}
                                    {environment.isProduction ? (
                                      <Badge tone="production">Production</Badge>
                                    ) : null}
                                  </span>
                                  <span className="flex items-center gap-4">
                                    {GRANTABLE_LEVELS.map((level) => (
                                      <label
                                        key={level}
                                        className={cn(
                                          'text-fg-muted flex items-center gap-1.5 text-[0.8125rem]',
                                          mayEdit && !saving && 'cursor-pointer',
                                        )}
                                      >
                                        <Checkbox
                                          checked={environment.level === level}
                                          disabled={!mayEdit || saving}
                                          onCheckedChange={(checked) =>
                                            void setLevel(
                                              project.slug,
                                              environment.slug,
                                              checked === true ? level : 'none',
                                            )
                                          }
                                          aria-label={`${ACCESS_LEVEL_LABELS[level]} access to ${project.name} ${environment.name}`}
                                        />
                                        {ACCESS_LEVEL_LABELS[level]}
                                      </label>
                                    ))}
                                  </span>
                                </div>
                              );
                            })
                          : null}
                      </section>
                    );
                  })
                )}

                <p className="text-fg-subtle text-xs">
                  Owners and admins hold admin access everywhere by their role; an unticked
                  environment here still means no explicit grant, and unticking writes an explicit
                  “no access” that overrides even a role default.
                </p>
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {removing !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => (next ? undefined : setRemoving(null))}
          title={`Remove access to ${removing.name}?`}
          description={`Every environment of ${removing.name} becomes “no access” for ${member.displayName ?? member.email}. Nothing they created is touched, and access can be granted again here at any time.`}
          confirmLabel="Remove access"
          onConfirm={async () => {
            const target = removing;
            setRemoving(null);
            await removeProject(target);
          }}
        />
      ) : null}
    </>
  );
}
