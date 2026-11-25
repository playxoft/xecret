import type { Metadata } from 'next';

import { isUuid } from '@xecret/core/ids';

import { EnvironmentSettingsScreen } from '../../../../../_components/environment-settings-screen';
import { LegacyProjectAddress } from '../../../../../_components/legacy-project-address';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]/settings'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} settings` };
}

export default async function EnvironmentSettingsPage({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]/settings'>) {
  const { orgSlug, projectId, envSlug } = await params;
  if (!isUuid(projectId)) return <LegacyProjectAddress orgSlug={orgSlug} projectSlug={projectId} />;
  return (
    <EnvironmentSettingsScreen
      key={`${orgSlug}/${projectId}/${envSlug}`}
      orgSlug={orgSlug}
      projectId={projectId}
      envSlug={envSlug}
    />
  );
}
