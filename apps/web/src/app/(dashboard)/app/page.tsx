import type { Metadata } from 'next';

import { OrganizationsScreen } from '../_components/organizations-screen';

export const metadata: Metadata = { title: 'Organisations' };

/**
 * `?to=plans` — sent by the pricing page to a visitor who already has an
 * account — opens the plans page of their organisation instead of its
 * projects (or asks which one, for somebody in several).
 */
export default async function OrganizationsPage({ searchParams }: PageProps<'/app'>) {
  const { to } = await searchParams;
  return <OrganizationsScreen intent={to === 'plans' ? 'plans' : null} />;
}
