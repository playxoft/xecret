import type { Metadata } from 'next';

import { OrganizationsScreen } from '../_components/organizations-screen';

export const metadata: Metadata = { title: 'Organisations' };

export default function OrganizationsPage() {
  return <OrganizationsScreen />;
}
