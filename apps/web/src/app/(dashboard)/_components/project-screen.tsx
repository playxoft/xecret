'use client';

import { useCallback, useEffect, useState } from 'react';

import { api, isApiError } from '@/lib/api';
import { PageHeader } from '@/components/layout';
import { Button, EmptyState, LayersIcon } from '@/components/ui';
import { CreateEnvironmentDialog } from '@/components/projects/create-environment-dialog';
import { EnvironmentCards } from '@/components/projects/environment-cards';
import type { SecretCounts } from '@/components/projects/environment-cards';
import { ProjectActions } from '@/components/projects/project-actions';
import type { EnvironmentResponse, ProjectResponse } from '@/components/projects/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { CardGridSkeleton, ErrorState } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

export function ProjectScreen({ orgSlug, projectSlug }: { orgSlug: string; projectSlug: string }) {
  const organization = useOrganization(orgSlug);
  const project = useApiResource<ProjectResponse>(apiPath.project(orgSlug, projectSlug));
  const [creating, setCreating] = useState(false);

  const environments = project.data?.environments;
  const counts = useSecretCounts(orgSlug, projectSlug, environments);

  const canManage = organization !== null && isOrgAdmin(organization.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={project.data?.project.name ?? projectSlug}
        titleLoading={project.data === null && project.error === null}
        description={project.data?.project.description ?? undefined}
        actions={
          project.data === null ? undefined : (
            <>
              {canManage ? (
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  New environment
                </Button>
              ) : null}
              <ProjectActions
                orgSlug={orgSlug}
                project={project.data.project}
                environments={project.data.environments}
                canManage={canManage}
                onChanged={project.reload}
              />
            </>
          )
        }
      />

      {project.loading && project.data === null ? (
        <CardGridSkeleton count={3} />
      ) : project.error !== null ? (
        <ErrorState subject="this project" error={project.error} onRetry={project.reload} />
      ) : project.data !== null && project.data.environments.length === 0 ? (
        <EmptyState
          icon={<LayersIcon />}
          title="This project has no environments"
          description="An environment is where secrets live — one per deployment target. Each gets its own encryption key, so a compromise of one does not reach the others."
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create an environment
              </Button>
            ) : undefined
          }
        />
      ) : project.data !== null ? (
        <EnvironmentCards
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          environments={project.data.environments}
          counts={counts}
        />
      ) : null}

      {project.data !== null ? (
        <CreateEnvironmentDialog
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          nextSortOrder={project.data.environments.length}
          open={creating}
          onOpenChange={setCreating}
          onCreated={project.reload}
        />
      ) : null}
    </div>
  );
}

/**
 * How many secrets each environment holds.
 *
 * ── Why this is a second, separate round of requests ──
 * `GET …/projects/{slug}` lists the environments but not their contents, because
 * listing an environment's shape and reading inside it are different
 * permissions: production denies `environment.read` to a developer with no
 * grant. Folding a count into the project response would therefore mean either
 * leaking a fact about a denied environment or omitting the environment
 * entirely, and neither is right.
 *
 * So the counts are fetched per environment, after the cards are already on
 * screen, and a failure is recorded as "no access" rather than as an error: for
 * production that is the expected answer, not a fault. The cost is one small
 * request per environment — three, for a project with the defaults — none of
 * which blocks the first paint.
 */
function useSecretCounts(
  orgSlug: string,
  projectSlug: string,
  environments: readonly { slug: string }[] | undefined,
): SecretCounts {
  // Tagged with the environment set it describes, so counts belonging to the
  // previous project are discarded by the derivation at the end rather than
  // cleared by a synchronous setState inside the effect.
  const [counts, setCounts] = useState<{ key: string; values: SecretCounts }>({
    key: '',
    values: {},
  });

  // The slugs, joined, so the effect re-runs when the set of environments
  // changes but not on every re-render that produces an equal array.
  const key = environments?.map((environment) => environment.slug).join(',') ?? '';

  const record = useCallback((forKey: string, slug: string, value: number | null) => {
    setCounts((current) => ({
      key: forKey,
      values: { ...(current.key === forKey ? current.values : {}), [slug]: value },
    }));
  }, []);

  const load = useCallback(
    async (forKey: string, slugs: readonly string[], signal: AbortSignal) => {
      await Promise.all(
        slugs.map(async (slug) => {
          try {
            const response = await api.get<EnvironmentResponse>(
              apiPath.environment(orgSlug, projectSlug, slug),
              { signal },
            );
            if (!signal.aborted) record(forKey, slug, response.environment.secretCount);
          } catch (cause) {
            if (signal.aborted) return;
            // 403 and 404 both mean "not for you" here — §3 makes them
            // deliberately hard to tell apart — so both become "no access".
            // Anything else is left as "still loading" rather than asserting a
            // permission fact the response did not establish.
            if (isApiError(cause) && (cause.code === 'forbidden' || cause.code === 'not_found')) {
              record(forKey, slug, null);
            }
          }
        }),
      );
    },
    [orgSlug, projectSlug, record],
  );

  useEffect(() => {
    if (key === '') return;
    const controller = new AbortController();
    void load(key, key.split(','), controller.signal);
    return () => controller.abort();
  }, [key, load]);

  return counts.key === key ? counts.values : {};
}
