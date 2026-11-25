import type { Metadata } from 'next';

import { OrganizationGeneralSettings } from '../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Organisation settings' };

/**
 * General: the organisation's name, its slug and who you are in it. The area's
 * own address, so every link to "organisation settings" lands here — and a
 * link from before the other sections had addresses, `…/settings#webhooks`,
 * is sent on to the section that holds that card now.
 */
export default async function OrganizationSettingsPage({
  params,
}: PageProps<'/app/[orgSlug]/settings'>) {
  const { orgSlug } = await params;
  return <OrganizationGeneralSettings key={orgSlug} orgSlug={orgSlug} />;
}
