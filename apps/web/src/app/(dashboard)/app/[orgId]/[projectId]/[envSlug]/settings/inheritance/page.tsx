import type { Metadata } from 'next';

import { EnvironmentInheritanceSettings } from '../../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgId]/[projectId]/[envSlug]/settings/inheritance'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} inheritance` };
}

export default function EnvironmentInheritancePage() {
  return <EnvironmentInheritanceSettings />;
}
