import type { Metadata } from 'next';

import { OrganizationSettingsScreen } from '../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Organisation settings' };

export default async function OrganizationSettingsPage({
  params,
}: PageProps<'/app/[orgSlug]/settings'>) {
  const { orgSlug } = await params;
  return <OrganizationSettingsScreen key={orgSlug} orgSlug={orgSlug} />;
}
