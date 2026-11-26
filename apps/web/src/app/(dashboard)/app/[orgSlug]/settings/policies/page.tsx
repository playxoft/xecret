import type { Metadata } from 'next';

import { OrganizationPoliciesSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Policies' };

export default async function OrganizationPoliciesPage({
  params,
}: PageProps<'/app/[orgSlug]/settings/policies'>) {
  const { orgSlug } = await params;
  return <OrganizationPoliciesSettings key={orgSlug} orgSlug={orgSlug} />;
}
