import type { Metadata } from 'next';

import { OrganizationWebhooksSettings } from '../../../../_components/organization-settings-screen';

export const metadata: Metadata = { title: 'Webhooks' };

/** Where the "a webhook was switched off" email sends an administrator. */
export default async function OrganizationWebhooksPage({
  params,
}: PageProps<'/app/[orgId]/settings/webhooks'>) {
  const { orgId } = await params;
  return <OrganizationWebhooksSettings key={orgId} orgId={orgId} />;
}
