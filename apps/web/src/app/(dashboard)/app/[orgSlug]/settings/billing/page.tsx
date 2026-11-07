import type { Metadata } from 'next';

import { BillingScreen } from '../../../../_components/billing-screen';
import { billingChoiceFromQuery } from '../../../../_components/upgrade-plans';

export const metadata: Metadata = { title: 'Billing' };

/**
 * The billing screen (P12). Dodo's checkout and customer portal send the
 * browser back here; `?checkout=returned` says it came back from a checkout,
 * which the screen uses only to say "waiting for the payment to be confirmed" —
 * it grants nothing.
 *
 * `?plan=` and `?interval=` are where the plans page's "Switch to …" points
 * the change form. Validated against the two plans and two periods and
 * otherwise ignored, so a hand-typed value opens the form as it always did.
 */
export default async function BillingPage({
  params,
  searchParams,
}: PageProps<'/app/[orgSlug]/settings/billing'>) {
  const { orgSlug } = await params;
  const query = await searchParams;
  return (
    <BillingScreen
      key={orgSlug}
      orgSlug={orgSlug}
      returnedFromCheckout={query['checkout'] === 'returned'}
      initialChoice={billingChoiceFromQuery(query)}
    />
  );
}
