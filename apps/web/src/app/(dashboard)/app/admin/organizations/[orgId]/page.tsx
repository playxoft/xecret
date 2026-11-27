import type { Metadata } from 'next';

import { AdminOrganizationScreen } from '../../../../_components/admin-organization-screen';

export const metadata: Metadata = { title: 'Organisation · Admin' };

/**
 * One organisation on the admin page, by id. Admins only: anybody else is
 * shown the 404 the screen throws before it asks anything, the answer its API
 * gives them too (`server/admin.ts`).
 */
export default async function AdminOrganizationPage({
  params,
}: PageProps<'/app/admin/organizations/[orgId]'>) {
  const { orgId } = await params;
  // Keyed on the id, so going from one organisation to another remounts
  // rather than showing the first one's members under the second's name.
  return <AdminOrganizationScreen key={orgId} orgId={orgId} />;
}
