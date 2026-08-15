'use client';

import { useState } from 'react';

import type { AccessLevel } from '@xecret/core/authz';
import { api, errorMessage } from '@/lib/api';
import {
  Alert,
  Badge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { ACCESS_LEVEL_LABELS, ACCESS_SOURCE_LABELS, ROLE_LABELS, ROLE_TONE } from './types';
import type { Member, MemberAccessResponse } from './types';

/**
 * One member's access, in a dialog over the member list.
 *
 * A dialog rather than a page, deliberately: "what can this person reach" is a
 * question asked *about a row* — the answer belongs beside the list it came
 * from, not a navigation away from it, and closing it lands the viewer exactly
 * where they were.
 *
 * The matrix is the effective-permission preview — every level computed
 * server-side by the same `resolveAccessLevel` the authorization engine calls,
 * with the rule that produced it named beside it. The editor changes one cell
 * at a time and re-reads the whole answer, so what is shown after a change is
 * what the server now enforces, never a local prediction of it.
 *
 * The access is fetched only while the dialog is open — sixty rows each
 * prefetching a matrix nobody asked to see would be sixty wasted requests —
 * and the dialog's own body is the one vertical scroll: `TableContainer`
 * scrolls horizontally at most, so a long project list scrolls as one page.
 *
 * Levels are written as text rather than colour-coded: four colours in a grid
 * make a legend, and the one distinction that changes what an action costs —
 * production — already has its own marking.
 */

const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];

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

  async function setLevel(
    projectSlug: string,
    environmentSlug: string | null,
    level: AccessLevel | 'default',
  ) {
    const cell = `${projectSlug}/${environmentSlug ?? '*'}`;
    setSavingCell(cell);
    setError(null);
    try {
      if (level === 'default') {
        await api.delete(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug,
          environmentSlug,
        });
      } else {
        await api.put(apiPath.memberGrants(orgSlug, member.id), {
          projectSlug,
          environmentSlug,
          accessLevel: level,
        });
      }
      toast({ variant: 'success', title: 'Access updated' });
      access.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setSavingCell(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {member.displayName ?? member.email}
            <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>{ROLE_LABELS[member.role]}</Badge>
            {member.status === 'suspended' ? <Badge tone="warning">Suspended</Badge> : null}
          </DialogTitle>
          <DialogDescription>
            {mayEdit
              ? 'What this member can reach, the rule that decides it, and the overrides that change it.'
              : 'What this member can reach, and the rule that decides it.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-5">
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
              className="flex flex-col gap-4"
            >
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} className="h-36 w-full rounded-xl" />
              ))}
            </div>
          ) : access.data.projects.length === 0 ? (
            <p className="text-fg-muted text-[0.8125rem]">
              This organisation has no projects yet, so there is nothing to grant.
            </p>
          ) : (
            access.data.projects.map((project) => {
              const projectGrant = access.data?.grants.find(
                (grant) => grant.projectSlug === project.slug && grant.environmentSlug === null,
              );

              return (
                <section key={project.slug} className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-fg text-sm font-semibold">{project.name}</h3>
                      <p className="text-fg-muted text-[0.8125rem]">
                        Project-wide:{' '}
                        {projectGrant !== undefined
                          ? `${ACCESS_LEVEL_LABELS[projectGrant.accessLevel]} (granted)`
                          : `${ACCESS_LEVEL_LABELS[project.projectLevel]} (role default)`}
                      </p>
                    </div>
                    {mayEdit ? (
                      <LevelSelect
                        label={`Project-wide access to ${project.name}`}
                        value={projectGrant?.accessLevel ?? 'default'}
                        saving={savingCell === `${project.slug}/*`}
                        onChange={(level) => void setLevel(project.slug, null, level)}
                      />
                    ) : null}
                  </div>

                  <TableContainer aria-label={`Access to ${project.name} by environment`}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Environment</TableHead>
                          <TableHead className="w-32">Access</TableHead>
                          <TableHead className="w-44">Decided by</TableHead>
                          {mayEdit ? <TableHead className="w-44">Override</TableHead> : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {project.environments.map((environment) => {
                          const grant = access.data?.grants.find(
                            (candidate) =>
                              candidate.projectSlug === project.slug &&
                              candidate.environmentSlug === environment.slug,
                          );
                          const cell = `${project.slug}/${environment.slug}`;

                          return (
                            <TableRow key={environment.slug}>
                              <TableCell>
                                <span className="flex items-center gap-2 text-[0.8125rem]">
                                  {environment.name}
                                  {environment.isProduction ? (
                                    <Badge tone="production">Production</Badge>
                                  ) : null}
                                </span>
                              </TableCell>
                              <TableCell>
                                <span
                                  className={
                                    environment.level === 'none'
                                      ? 'text-fg-subtle text-[0.8125rem]'
                                      : 'text-fg text-[0.8125rem] font-medium'
                                  }
                                >
                                  {ACCESS_LEVEL_LABELS[environment.level]}
                                </span>
                              </TableCell>
                              <TableCell className="text-fg-muted text-[0.8125rem]">
                                {ACCESS_SOURCE_LABELS[environment.source]}
                              </TableCell>
                              {mayEdit ? (
                                <TableCell>
                                  <LevelSelect
                                    label={`Access to ${project.name} ${environment.name}`}
                                    value={grant?.accessLevel ?? 'default'}
                                    saving={savingCell === cell}
                                    onChange={(level) =>
                                      void setLevel(project.slug, environment.slug, level)
                                    }
                                  />
                                </TableCell>
                              ) : null}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </section>
              );
            })
          )}

          <p className="text-fg-subtle text-xs">
            “Role default” follows the member&apos;s role — production is no-access by default for
            everyone below admin. An explicit grant overrides the default in both directions, and an
            explicit “No access” denies even an owner.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One cell's override control: the four levels plus "Role default", which
 * removes the grant rather than storing a level — the distinction the engine
 * cares about, made visible.
 */
function LevelSelect({
  label,
  value,
  saving,
  onChange,
}: {
  label: string;
  value: AccessLevel | 'default';
  saving: boolean;
  onChange: (level: AccessLevel | 'default') => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as AccessLevel | 'default')}
      disabled={saving}
    >
      <SelectTrigger className="h-8 w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Role default</SelectItem>
        {LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {ACCESS_LEVEL_LABELS[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
