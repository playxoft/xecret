import type { Metadata } from 'next';

import { UpgradeScreen } from '../../../_components/upgrade-screen';

export const metadata: Metadata = { title: 'Upgrade' };

/**
 * The plans, inside the app. Open to every member; only an owner is offered a
 * checkout. Dodo returns to the billing screen, not here — `?checkout=returned`
 * reaching this page is only pointed there.
 *
 * `upgrade` sits in the slot a project slug takes, so it is on the reserved
 * slug list and in `parseDashboardPath`'s organisation pages.
 */
export default async function UpgradePage({
  params,
  searchParams,
}: PageProps<'/app/[orgSlug]/upgrade'>) {
  const { orgSlug } = await params;
  const { checkout } = await searchParams;
  return (
    <UpgradeScreen key={orgSlug} orgSlug={orgSlug} returnedFromCheckout={checkout === 'returned'} />
  );
}
