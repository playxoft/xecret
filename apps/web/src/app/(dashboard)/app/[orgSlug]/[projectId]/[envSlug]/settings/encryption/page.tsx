import type { Metadata } from 'next';

import { EnvironmentEncryptionSettings } from '../../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectId]/[envSlug]/settings/encryption'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} encryption key` };
}

export default function EnvironmentEncryptionPage() {
  return <EnvironmentEncryptionSettings />;
}
