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
  ChevronRightIcon,
  ConfirmDialog,
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
import { ACCESS_LEVEL_LABELS } from './types';
import type { EffectiveProject, Member, MemberAccessResponse } from './types';

/**
 * One member's access, expanded in place under their row in the member list.
 *
 * An accordion rather than a dialog, so several members' access can be open
 * and compared side by side — "why can Ana reach production and Ben not" is a
 * two-row question, and a modal can only ever show one of them. The panel is
 * mounted only while its row is expanded, which is what gives every expansion
 * a clean slate and costs nothing for the rows nobody opens.
 *
 * ── The shape of the answer ──
 * Only projects the member can actually reach are listed. Each project folds
 * open to its environments, and access is granted **per environment**: there
 * is deliberately no project-wide level control, because "give them the
 * project" quietly including production is exactly the accident the
 * per-environment model exists to prevent.
 *
 * ── Levels are cumulative, and the toggles say so ──
 * Each environment offers three pills — Read, Read & write, Admin. A level
 * lights everything it contains and locks those pills: under Admin, Read and
 * Read & write are lit and cannot be turned off, so the pills can never show
 * a state the engine cannot mean. Clicking the highest lit pill steps down
 * one: Admin to Read & write, Read & write to Read, Read to nothing.
 *
 * ── Nothing is written until Save ──
 * Toggles are staged locally. Save applies the whole batch — one audited
 * grant write per changed environment — and folds the panel; Cancel discards
 * and folds. The button knows whether anything actually changed: a toggle
 * flipped and flipped back never enables it.
 *
 * "Add project" only reveals a project so its environments can be granted; it
 * writes nothing by itself. "Remove" is the one immediate act — confirmed,
 * then an explicit project-wide no-access plus the deletion of every
 * environment grant, deny first.
 *
 * Every level shown comes from the server's `resolveAccessLevel` — the same
 * function the authorization engine calls — so the panel cannot disagree with
 * what a request will experience.
 */

const GRANTABLE_LEVELS: readonly AccessLevel[] = ['read', 'write', 'admin'];

/** Cumulative order, for implication: everything below a level is contained in it. */
const LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/** What turning a level off leaves behind: the next level down. */
const LEVEL_BELOW: Readonly<Record<AccessLevel, AccessLevel>> = {
  none: 'none',
  read: 'none',
  write: 'read',
  admin: 'write',
};

export function MemberAccessPanel({
  orgSlug,
  member,
  mayEdit,
  onCollapse,
  onChanged,
}: {
  orgSlug: string;
  member: Member;
  /** Whether the viewer may change grants; the server re-checks every change. */
  mayEdit: boolean;
  /** Folds this panel — Save on success and Cancel both end here. */
  onCollapse: () => void;
  /** Grants changed on the server; the member list's project reach is stale. */
  onChanged: () => void;
}) {
  const access = useApiResource<MemberAccessResponse>(apiPath.memberAccess(orgSlug, member.id));
  const { toast } = useToast();
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Projects revealed by "Add project" but not yet holding any grant. Local
  // only: revealing is not an act the server needs to hear about.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  // The unsaved work: target level per `${project}/${environment}` cell, held
  // only where it differs from what the server said — so `size === 0` *is*
  // "nothing changed", and the Save button reads straight off it.
  const [staged, setStaged] = useState<ReadonlyMap<string, AccessLevel>>(new Map());
  const [removing, setRemoving] = useState<EffectiveProject | null>(null);

  const projects = access.data?.projects ?? [];
  const visible = projects.filter(
    (project) =>
      added.has(project.slug) ||
      project.environments.some((environment) => environment.level !== 'none'),
  );
  const assignable = projects.filter((project) => !visible.includes(project));
  const dirty = staged.size > 0;

  function shownLevel(projectSlug: string, environmentSlug: string, server: AccessLevel) {
    return staged.get(`${projectSlug}/${environmentSlug}`) ?? server;
  }

  function stageLevel(
    projectSlug: string,
    environmentSlug: string,
    server: AccessLevel,
    next: AccessLevel,
  ) {
    setStaged((current) => {
      const map = new Map(current);
      const cell = `${projectSlug}/${environmentSlug}`;
      if (next === server) map.delete(cell);
      else map.set(cell, next);
      return map;
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
        const [projectSlug, environmentSlug] = cell.split('/') as [string, string];
        await api.put(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug,
          environmentSlug,
          accessLevel: level,
        });
      }
      toast({
        variant: 'success',
        title: `Updated access for ${member.displayName ?? member.email}`,
      });
      onChanged();
      onCollapse();
    } catch (cause) {
      // The whole batch stays staged: re-saving re-sends everything, and the
      // writes that already landed answer as no-ops.
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Revokes the whole project: an explicit project-wide no-access, then the
   * deletion of every environment grant that would override it. Immediate and
   * confirmed, unlike the toggles — it is the one act here that is a removal
   * of standing access rather than an adjustment being composed.
   */
  async function removeProject(project: EffectiveProject) {
    setSaving(true);
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
      // Staged toggles for a project that was just revoked would be saved on
      // top of the revocation — exactly what the person removing it did not
      // mean.
      setStaged((current) => {
        const next = new Map(current);
        for (const cell of next.keys()) {
          if (cell.startsWith(`${project.slug}/`)) next.delete(cell);
        }
        return next;
      });
      onChanged();
      access.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
      {error !== null ? (
        <Alert tone="danger" title="That change was not saved">
          {errorMessage(error)}
        </Alert>
      ) : null}

      {member.status === 'suspended' ? (
        <Alert tone="warning" title="This member is suspended">
          Every request they make is denied. The levels below show what their access will be once
          reinstated.
        </Alert>
      ) : null}

      {access.error !== null ? (
        <Alert tone="danger" title="Their access could not be loaded">
          {errorMessage(access.error)}
        </Alert>
      ) : access.data === null ? (
        <div aria-busy="true" aria-label="Loading member access" className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-fg-subtle text-[0.8125rem]">
              {visible.length === 0
                ? 'No project access.'
                : `Access to ${pluralize(visible.length, 'project')} — granted per environment, never per project.`}
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
                      onSelect={() => {
                        setAdded((current) => new Set(current).add(project.slug));
                        setExpanded((current) => new Set(current).add(project.slug));
                      }}
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
                (environment) =>
                  shownLevel(project.slug, environment.slug, environment.level) !== 'none',
              ).length;

              return (
                <section
                  key={project.slug}
                  className="border-line bg-surface overflow-hidden rounded-lg border"
                >
                  <div className="flex items-center gap-1 py-1 pr-2 pl-1">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(project.slug)) next.delete(project.slug);
                          else next.add(project.slug);
                          return next;
                        })
                      }
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
                      <span className="text-fg truncate text-sm font-semibold">{project.name}</span>
                      <span className="text-fg-subtle text-xs whitespace-nowrap">
                        {granted} of {pluralize(project.environments.length, 'environment')}
                      </span>
                    </button>
                    {mayEdit ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-text hover:text-danger-text"
                        disabled={saving}
                        onClick={() => setRemoving(project)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>

                  {isOpen
                    ? project.environments.map((environment) => {
                        const level = shownLevel(project.slug, environment.slug, environment.level);

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
                            <span className="flex items-center gap-1.5">
                              {GRANTABLE_LEVELS.map((pill) => {
                                // A pill is lit when the level reaches it, and
                                // locked while a higher level contains it —
                                // Read cannot go out while Read & write holds.
                                const lit = LEVEL_RANK[level] >= LEVEL_RANK[pill];
                                const locked = LEVEL_RANK[level] > LEVEL_RANK[pill];

                                return (
                                  <LevelPill
                                    key={pill}
                                    label={ACCESS_LEVEL_LABELS[pill]}
                                    lit={lit}
                                    locked={locked}
                                    disabled={!mayEdit || saving}
                                    ariaLabel={`${ACCESS_LEVEL_LABELS[pill]} access to ${project.name} ${environment.name}`}
                                    onToggle={() =>
                                      stageLevel(
                                        project.slug,
                                        environment.slug,
                                        environment.level,
                                        lit ? LEVEL_BELOW[pill] : pill,
                                      )
                                    }
                                  />
                                );
                              })}
                            </span>
                          </div>
                        );
                      })
                    : null}
                </section>
              );
            })
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <p className="text-fg-subtle mr-auto text-xs">
              Owners and admins hold admin access everywhere by their role; turning a level off
              writes an explicit “no access” that overrides even a role default.
            </p>
            {mayEdit ? (
              <>
                <Button variant="ghost" size="sm" onClick={onCollapse} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  loading={saving}
                >
                  Save changes
                </Button>
              </>
            ) : null}
          </div>
        </>
      )}

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
    </div>
  );
}

/**
 * One access level as a toggle pill.
 *
 * `aria-pressed` carries the toggle semantics for assistive tech; a locked
 * pill stays lit but refuses the click, because its level is contained in a
 * higher one and turning it off alone would be a state the engine cannot hold.
 */
function LevelPill({
  label,
  lit,
  locked,
  disabled,
  ariaLabel,
  onToggle,
}: {
  label: string;
  lit: boolean;
  locked: boolean;
  disabled: boolean;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={lit}
      aria-label={ariaLabel}
      disabled={disabled || locked}
      onClick={onToggle}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        lit
          ? 'border-accent-line bg-accent-tint text-accent-text'
          : 'border-line bg-canvas-inset text-fg-muted',
        !disabled && !locked && 'cursor-pointer',
        !disabled && !locked && !lit && 'hover:border-line-strong hover:text-fg',
        // Locked pills keep their lit colours — they are on, just not yours to
        // turn off — while a fully disabled row reads muted.
        disabled && !lit && 'opacity-60',
      )}
    >
      {label}
    </button>
  );
}
