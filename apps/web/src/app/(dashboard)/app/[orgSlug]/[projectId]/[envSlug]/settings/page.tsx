import type { Metadata } from 'next';

import { EnvironmentGeneralSettings } from '../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]/settings'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} settings` };
}

/**
 * General: the environment's name, slug, display order and classification.
 * The area's own address — `appPath.environmentSettings` — so the environment
 * page's Settings button still opens here.
 */
export default function EnvironmentSettingsPage() {
  return <EnvironmentGeneralSettings />;
}
