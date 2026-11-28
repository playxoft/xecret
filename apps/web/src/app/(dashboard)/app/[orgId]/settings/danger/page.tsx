import type { Metadata } from 'next';

import { OrganizationDangerSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Delete organisation' };

export default async function OrganizationDangerPage({
  params,
}: PageProps<'/app/[orgId]/settings/danger'>) {
  const { orgId } = await params;
  return <OrganizationDangerSettings key={orgId} orgId={orgId} />;
}
