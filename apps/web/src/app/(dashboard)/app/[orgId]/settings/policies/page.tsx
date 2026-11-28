import type { Metadata } from 'next';

import { OrganizationPoliciesSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Policies' };

export default async function OrganizationPoliciesPage({
  params,
}: PageProps<'/app/[orgId]/settings/policies'>) {
  const { orgId } = await params;
  return <OrganizationPoliciesSettings key={orgId} orgId={orgId} />;
}
