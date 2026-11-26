import type { Metadata } from 'next';

import { AppearanceSettings } from '../../../_components/account-screen';

export const metadata: Metadata = { title: 'Appearance' };

export default function AppearanceSettingsPage() {
  return <AppearanceSettings />;
}
