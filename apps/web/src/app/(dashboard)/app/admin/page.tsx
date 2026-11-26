import type { Metadata } from 'next';

import { AdminScreen } from '../../_components/admin-screen';

export const metadata: Metadata = { title: 'Admin' };

/**
 * The admin page — xecret's own staff, giving organisations free plans and
 * issuing promo codes. A Server Component that renders the client screen, as
 * every dashboard page does: whether the viewer is an admin is the session's
 * answer, read in the browser, and anybody else is shown a 404 by the screen
 * (and by every request it would have made).
 *
 * `/app/admin` takes the place of an organisation slug, which is safe only
 * because `admin` is a reserved slug — see `appPath.admin`.
 */
export default function AdminPage() {
  return <AdminScreen />;
}
