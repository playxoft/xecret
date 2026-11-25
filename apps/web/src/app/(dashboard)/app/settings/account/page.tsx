import type { Metadata } from 'next';

import { ProfileSettings } from '../../../_components/account-screen';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfileSettingsPage() {
  return <ProfileSettings />;
}
