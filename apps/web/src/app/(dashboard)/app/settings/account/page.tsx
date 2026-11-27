import type { Metadata } from 'next';

import { ProfileSettings } from '../../../_components/account-screen';

/**
 * Named for the area rather than the section, as an organisation's General is
 * ("Organisation settings"): this is where `/app/settings` and the user menu's
 * "Account settings" land, so it is the tab somebody looks for by that name.
 * The other sections' tabs keep their own names.
 */
export const metadata: Metadata = { title: 'Account settings' };

export default function ProfileSettingsPage() {
  return <ProfileSettings />;
}
