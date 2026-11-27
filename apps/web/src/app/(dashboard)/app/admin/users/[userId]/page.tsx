import type { Metadata } from 'next';

import { AdminUserScreen } from '../../../../_components/admin-user-screen';

export const metadata: Metadata = { title: 'User · Admin' };

/**
 * One account on the admin page, by id. Admins only: anybody else is shown
 * the 404 the screen throws before it asks anything, the answer its API gives
 * them too (`server/admin.ts`).
 */
export default async function AdminUserPage({ params }: PageProps<'/app/admin/users/[userId]'>) {
  const { userId } = await params;
  return <AdminUserScreen key={userId} userId={userId} />;
}
