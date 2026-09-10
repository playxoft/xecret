'use client';

import { PageHeader } from '@/components/layout';
import { EnvironmentBadge } from '@/components/projects/environment-badge';
import { EnvironmentSettingsForm } from '@/components/projects/environment-settings-form';
import { EnvironmentKeyCard } from '@/components/envkeys';
import type { EnvironmentResponse } from '@/components/projects/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState, FormSkeleton } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

export function EnvironmentSettingsScreen({
  orgSlug,
  projectSlug,
  envSlug,
}: {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}) {
  const organization = useOrganization(orgSlug);
  // This route needs the secret count, which only the environment detail
  // endpoint returns — the delete confirmation says how much is about to become
  // unreachable, and "some secrets" is not an answer anybody can act on.
  const environment = useApiResource<EnvironmentResponse>(
    apiPath.environment(orgSlug, projectSlug, envSlug),
  );

  const canManage = organization !== null && isOrgAdmin(organization.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`${environment.data?.environment.name ?? envSlug} settings`}
        titleLoading={environment.data === null && environment.error === null}
        badge={
          <EnvironmentBadge isProduction={environment.data?.environment.isProduction ?? false} />
        }
        description="How this environment is named, ordered and classified — and the key its values are encrypted under."
      />

      {environment.loading && environment.data === null ? (
        <FormSkeleton />
      ) : environment.error !== null ? (
        <ErrorState
          subject="this environment"
          error={environment.error}
          onRetry={environment.reload}
        />
      ) : environment.data !== null ? (
        <>
          <EnvironmentSettingsForm
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            environment={environment.data.environment}
            canManage={canManage}
            onChanged={environment.reload}
          />

          {/* Below the naming form, because rotating is a rarer and heavier act
              than renaming — and because the card has to read the key state,
              which is a second request this page should not block on. */}
          <EnvironmentKeyCard
            orgSlug={orgSlug}
            projectSlug={projectSlug}
            envSlug={envSlug}
            environmentName={environment.data.environment.name}
            isProduction={environment.data.environment.isProduction}
            canManage={canManage}
          />
        </>
      ) : null}
    </div>
  );
}
