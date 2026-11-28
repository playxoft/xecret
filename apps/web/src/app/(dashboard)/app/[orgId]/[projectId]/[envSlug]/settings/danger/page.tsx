import type { Metadata } from 'next';

import { EnvironmentDangerSettings } from '../../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgId]/[projectId]/[envSlug]/settings/danger'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `Delete ${envSlug}` };
}

export default function EnvironmentDangerPage() {
  return <EnvironmentDangerSettings />;
}
