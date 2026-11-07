import type { Metadata } from 'next';

import { OVERAGE_RATE_TEXT } from '@/server/billing/money';
import { takesCheckouts } from '@/server/billing/payments-live';
import { UpgradeScreen } from '../../../../_components/upgrade-screen';

export const metadata: Metadata = { title: 'Plans' };

/**
 * The plans, inside the app. Open to every member; only an owner is offered a
 * checkout. Under `settings`, beside billing — see `appPath.orgPlans` for why
 * it is not at `/app/{org}/upgrade`.
 *
 * Two things only the server knows, handed down as props:
 *
 *  - whether this deployment takes payments at all (`takesCheckouts` — live or
 *    Dodo's test mode). Where it does not, the page compares the plans without
 *    a price, a button or a sentence about who could press one;
 *  - the overage rate, as the billing screen and the usage emails print it
 *    (`OVERAGE_RATE_TEXT`), so the page never restates it.
 *
 * Dodo returns to the billing screen, not here — `?checkout=returned` reaching
 * this page is only pointed there.
 */
export default async function PlansPage({
  params,
  searchParams,
}: PageProps<'/app/[orgSlug]/settings/plans'>) {
  const { orgSlug } = await params;
  const { checkout } = await searchParams;
  const takesPayments = await takesCheckouts();
  return (
    <UpgradeScreen
      key={orgSlug}
      orgSlug={orgSlug}
      returnedFromCheckout={checkout === 'returned'}
      payments={{ taken: takesPayments, overageRate: OVERAGE_RATE_TEXT }}
    />
  );
}
