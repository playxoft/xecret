import type { Metadata } from 'next';

import { OrganizationDangerSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Delete organisation' };

export default async function OrganizationDangerPage({
  params,
}: PageProps<'/app/[orgSlug]/settings/danger'>) {
  const { orgSlug } = await params;
  return <OrganizationDangerSettings key={orgSlug} orgSlug={orgSlug} />;
}
