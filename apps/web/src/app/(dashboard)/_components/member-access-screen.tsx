'use client';

import { useState } from 'react';

import type { AccessLevel } from '@xecret/core/authz';
import { api, errorMessage } from '@/lib/api';
import { PageHeader } from '@/components/layout';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import {
  ACCESS_LEVEL_LABELS,
  ACCESS_SOURCE_LABELS,
  ROLE_LABELS,
  ROLE_TONE,
} from '@/components/members/types';
import type { MemberAccessResponse } from '@/components/members/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

/**
 * One member: what they can actually reach, and the grants that decide it.
 *
 * The matrix is the effective-permission preview — every level computed
 * server-side by the same `resolveAccessLevel` the authorization engine calls,
 * with the rule that produced it named beside it. The editor changes one cell
 * at a time and re-reads the whole answer, so what is shown after a change is
 * what the server now enforces, never a local prediction of it.
 *
 * Levels are written as text rather than colour-coded: four colours in a grid
 * make a legend, and the one distinction that changes what an action costs —
 * production — already has its own marking.
 */

const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];

export function MemberAccessScreen({ orgSlug, memberId }: { orgSlug: string; memberId: string }) {
  const organization = useOrganization(orgSlug);
  const canManage = organization !== null && isOrgAdmin(organization.role);

  const access = useApiResource<MemberAccessResponse>(apiPath.memberAccess(orgSlug, memberId));
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
        await api.delete(apiPath.memberGrants(orgSlug, memberId), {
          projectSlug,
          environmentSlug,
        });
      } else {
        await api.put(apiPath.memberGrants(orgSlug, memberId), {
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

  const member = access.data?.member;
  const mayEdit = canManage && member !== undefined && !member.isYou;

  return (
    <div className="flex flex-col gap-6">
      {access.error !== null ? (
        <ErrorState subject="this member" error={access.error} onRetry={access.reload} />
      ) : access.data === null || member === undefined ? (
        <AccessSkeleton />
      ) : (
        <>
          <PageHeader
            title={member.displayName ?? member.email}
            description={
              member.displayName !== null ? member.email : 'What this member can reach, and why.'
            }
            badge={
              <span className="flex items-center gap-2">
                <Badge tone={ROLE_TONE[member.role] ?? 'neutral'}>{ROLE_LABELS[member.role]}</Badge>
                {member.status === 'suspended' ? <Badge tone="warning">Suspended</Badge> : null}
              </span>
            }
          />

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

          {access.data.projects.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-fg-muted text-[0.8125rem]">
                  This organisation has no projects yet, so there is nothing to grant.
                </p>
              </CardContent>
            </Card>
          ) : (
            access.data.projects.map((project) => {
              const projectGrant = access.data?.grants.find(
                (grant) => grant.projectSlug === project.slug && grant.environmentSlug === null,
              );

              return (
                <Card key={project.slug}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <CardTitle>{project.name}</CardTitle>
                        <CardDescription>
                          Project-wide:{' '}
                          {projectGrant !== undefined
                            ? `${ACCESS_LEVEL_LABELS[projectGrant.accessLevel]} (granted)`
                            : `${ACCESS_LEVEL_LABELS[project.projectLevel]} (role default)`}
                        </CardDescription>
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
                  </CardHeader>
                  <CardContent>
                    <TableContainer aria-label={`Access to ${project.name} by environment`}>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Environment</TableHead>
                            <TableHead className="w-36">Access</TableHead>
                            <TableHead className="w-48">Decided by</TableHead>
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
                  </CardContent>
                </Card>
              );
            })
          )}

          <p className="text-fg-subtle text-xs">
            “Role default” follows the member&apos;s role — production is no-access by default for
            everyone below admin. An explicit grant overrides the default in both directions, and an
            explicit “No access” denies even an owner.
          </p>
        </>
      )}
    </div>
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

function AccessSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading member access" className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-6 w-52" />
      </div>
      {Array.from({ length: 2 }, (_, index) => (
        <Skeleton key={index} className="h-44 w-full rounded-xl" />
      ))}
    </div>
  );
}
