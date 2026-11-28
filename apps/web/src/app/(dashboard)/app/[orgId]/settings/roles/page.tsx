import type { Metadata } from 'next';

import { OrganizationRolesSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Roles' };

export default async function OrganizationRolesPage({
  params,
}: PageProps<'/app/[orgId]/settings/roles'>) {
  const { orgId } = await params;
  return <OrganizationRolesSettings key={orgId} orgId={orgId} />;
}
