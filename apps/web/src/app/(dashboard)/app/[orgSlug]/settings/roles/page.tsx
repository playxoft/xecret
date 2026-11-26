import type { Metadata } from 'next';

import { OrganizationRolesSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Roles' };

export default async function OrganizationRolesPage({
  params,
}: PageProps<'/app/[orgSlug]/settings/roles'>) {
  const { orgSlug } = await params;
  return <OrganizationRolesSettings key={orgSlug} orgSlug={orgSlug} />;
}
