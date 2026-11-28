import type { Metadata } from 'next';

import { OrganizationSingleSignOnSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Single sign-on' };

/** Where the WorkOS setup portal sends an owner back to (`…/sso/portal/route.ts`). */
export default async function OrganizationSingleSignOnPage({
  params,
}: PageProps<'/app/[orgId]/settings/single-sign-on'>) {
  const { orgId } = await params;
  return <OrganizationSingleSignOnSettings key={orgId} orgId={orgId} />;
}
