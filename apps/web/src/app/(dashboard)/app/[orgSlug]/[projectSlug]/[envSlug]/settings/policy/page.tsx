import type { Metadata } from 'next';

import { EnvironmentPolicySettings } from '../../../../../../_components/environment-settings-screen';

export async function generateMetadata({
  params,
}: PageProps<'/app/[orgSlug]/[projectSlug]/[envSlug]/settings/policy'>): Promise<Metadata> {
  const { envSlug } = await params;
  return { title: `${envSlug} policy` };
}

/** Where the read-alert emails send an administrator to switch the alerts off. */
export default function EnvironmentPolicyPage() {
  return <EnvironmentPolicySettings />;
}
