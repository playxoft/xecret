import type { Metadata } from 'next';

import { EnvironmentSettingsScreen } from '../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]/[envSlug]/settings'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} settings` };
}

export default async function EnvironmentSettingsPage({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]/[envSlug]/settings'>) {
  const { orgSlug, projectSlug, envSlug } = await params;
  return (
    <EnvironmentSettingsScreen
      key={`${orgSlug}/${projectSlug}/${envSlug}`}
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      envSlug={envSlug}
    />
  );
}
