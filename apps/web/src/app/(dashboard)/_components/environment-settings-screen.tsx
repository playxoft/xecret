'use client';

import { createContext, use, useMemo } from 'react';
import type { ReactNode } from 'react';

import { PageHeader } from '@/components/layout';
import { EnvironmentBadge } from '@/components/projects/environment-badge';
import {
  DeleteEnvironmentCard,
  EnvironmentSettingsForm,
} from '@/components/projects/environment-settings-form';
import { EnvironmentKeyCard } from '@/components/envkeys';
import { EnvironmentPolicyCard } from '@/components/environments/environment-policy-card';
import { InheritanceCard } from '@/components/environments/inheritance-card';
import type { EnvironmentDetail, EnvironmentResponse } from '@/components/projects/types';
import { Alert } from '@/components/ui';
import { apiPath, appPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState, FormSkeleton } from './resource-states';
import { canAdminister, useOrganization, useSession } from './session';
import { SettingsLayout } from './settings-layout';
import { environmentSettingsSections } from './settings-sections';

/**
 * An environment's settings: how it is named, ordered and classified, the key
 * its values are encrypted under, what it inherits, how its values may leave
 * it, and its deletion — one section each, routes under
 * `/app/{org}/{project}/{env}/settings` in the shared settings frame. See
 * `settings-sections.ts` for the list and who is shown which.
 */

interface EnvironmentSettingsValue {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  environment: EnvironmentDetail;
  /** Whether the viewer holds `environment.update`. */
  canManage: boolean;
  /** Re-reads the environment, for a section that changed it. */
  reload: () => void;
}

/**
 * The environment, read once by the frame and handed to whichever section is
 * open.
 *
 * Read by the frame rather than by each section because the frame needs it
 * anyway — the heading names the environment and badges production — and
 * because it outlives the sections: moving from General to Policy re-renders
 * the section, not the frame, so the environment is not fetched again for
 * every click in the nav. Every section's change reloads it here, which is
 * what keeps the heading's badge and the other sections describing the
 * environment as it now is.
 */
const EnvironmentSettingsContext = createContext<EnvironmentSettingsValue | null>(null);

function useEnvironmentSettings(): EnvironmentSettingsValue {
  const value = use(EnvironmentSettingsContext);
  if (value === null) {
    throw new Error('An environment settings section must be inside its settings layout.');
  }
  return value;
}

export function EnvironmentSettingsLayout({
  orgSlug,
  projectSlug,
  envSlug,
  children,
}: {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  children: ReactNode;
}) {
  const organization = useOrganization(orgSlug);
  // This area needs the secret count, which only the environment detail
  // endpoint returns — the delete confirmation says how much is about to become
  // unreachable, and "some secrets" is not an answer anybody can act on.
  const environment = useApiResource<EnvironmentResponse>(
    apiPath.environment(orgSlug, projectSlug, envSlug),
  );
  const { reload } = environment;

  const canManage = canAdminister(organization, 'environment.update');
  const settingsHref = appPath.environmentSettings(orgSlug, projectSlug, envSlug);
  const groups = useMemo(
    () => environmentSettingsSections(settingsHref, organization),
    [settingsHref, organization],
  );

  const loaded = environment.data?.environment ?? null;
  const value = useMemo<EnvironmentSettingsValue | null>(
    () =>
      loaded === null
        ? null
        : {
            orgSlug,
            projectSlug,
            envSlug,
            environment: loaded,
            canManage,
            reload: () => void reload(),
          },
    [orgSlug, projectSlug, envSlug, loaded, canManage, reload],
  );

  return (
    <SettingsLayout
      label="Environment settings"
      groups={groups}
      header={
        <PageHeader
          size="lg"
          title={`${loaded?.name ?? envSlug} settings`}
          titleLoading={environment.data === null && environment.error === null}
          badge={<EnvironmentBadge isProduction={loaded?.isProduction ?? false} />}
          description="How this environment is named, ordered and classified, the key its values are encrypted under, what it inherits, and how its values may leave it."
        />
      }
    >
      {environment.loading && environment.data === null ? (
        <FormSkeleton />
      ) : environment.error !== null ? (
        <ErrorState
          subject="this environment"
          error={environment.error}
          onRetry={environment.reload}
        />
      ) : value !== null ? (
        <EnvironmentSettingsContext value={value}>{children}</EnvironmentSettingsContext>
      ) : null}
    </SettingsLayout>
  );
}

/** General — the name, the slug, the display order, and whether it is production. */
export function EnvironmentGeneralSettings() {
  const { orgSlug, projectSlug, environment, canManage, reload } = useEnvironmentSettings();
  const { refreshTrail } = useSession();

  return (
    <EnvironmentSettingsForm
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      environment={environment}
      canManage={canManage}
      onChanged={() => {
        reload();
        // The breadcrumb names this environment from the shell's own request,
        // so a rename here has to reach it too — or the heading takes the new
        // name and the crumb above it keeps the old one.
        refreshTrail();
      }}
    />
  );
}

/**
 * Encryption key — rotating it is a rarer and heavier act than renaming, and
 * the card reads the key state itself, a second request the other sections
 * should not wait on.
 */
export function EnvironmentEncryptionSettings() {
  const { orgSlug, projectSlug, envSlug, environment, canManage } = useEnvironmentSettings();

  return (
    <EnvironmentKeyCard
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      envSlug={envSlug}
      environmentName={environment.name}
      isProduction={environment.isProduction}
      canManage={canManage}
    />
  );
}

/**
 * Inheritance — where this environment's values come from. It reads its own
 * state and reloads the environment when it changes it, so the heading's
 * badge and General stay in step.
 */
export function EnvironmentInheritanceSettings() {
  const { orgSlug, projectSlug, environment, canManage, reload } = useEnvironmentSettings();

  return (
    <InheritanceCard
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      environment={environment}
      canManage={canManage}
      onChanged={reload}
    />
  );
}

/**
 * Policy — where this environment's values may go: plaintext export, and the
 * alert when it is read from somewhere new, with the list of everywhere it has
 * been read from. The read-alert emails link here.
 */
export function EnvironmentPolicySettings() {
  const { orgSlug, projectSlug, environment, canManage, reload } = useEnvironmentSettings();

  return (
    <EnvironmentPolicyCard
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      environment={environment}
      canManage={canManage}
      onChanged={reload}
    />
  );
}

/**
 * Danger zone — deleting the environment, for a viewer who holds
 * `environment.delete`. The section is not listed for anybody else; one who
 * arrives at its address anyway is told who can, rather than shown nothing.
 */
export function EnvironmentDangerSettings() {
  const { orgSlug, projectSlug, environment } = useEnvironmentSettings();
  const organization = useOrganization(orgSlug);

  if (!canAdminister(organization, 'environment.delete')) {
    return (
      <Alert tone="info" title="Only an owner or admin can delete this environment">
        <p>
          Deleting it makes every secret in it unreachable for everybody who reads it, so it is kept
          to the people who administer the organisation.
        </p>
      </Alert>
    );
  }

  return (
    <DeleteEnvironmentCard orgSlug={orgSlug} projectSlug={projectSlug} environment={environment} />
  );
}
