import type { Metadata } from 'next';

import { BillingScreen } from '../../../../_components/billing-screen';

export const metadata: Metadata = { title: 'Billing' };

/**
 * The billing screen (P12). Dodo's checkout and customer portal send the
 * browser back here; `?checkout=returned` says it came back from a checkout,
 * which the screen uses only to say "waiting for the payment to be confirmed" —
 * it grants nothing.
 */
export default async function BillingPage({
  params,
  searchParams,
}: PageProps<'/app/[orgSlug]/settings/billing'>) {
  const { orgSlug } = await params;
  const { checkout } = await searchParams;
  return (
    <BillingScreen key={orgSlug} orgSlug={orgSlug} returnedFromCheckout={checkout === 'returned'} />
  );
}
