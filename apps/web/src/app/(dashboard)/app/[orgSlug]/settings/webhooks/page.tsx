import type { Metadata } from 'next';

import { OrganizationWebhooksSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Webhooks' };

/** Where the "a webhook was switched off" email sends an administrator. */
export default async function OrganizationWebhooksPage({
  params,
}: PageProps<'/app/[orgSlug]/settings/webhooks'>) {
  const { orgSlug } = await params;
  return <OrganizationWebhooksSettings key={orgSlug} orgSlug={orgSlug} />;
}
