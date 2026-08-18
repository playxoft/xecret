import type { Metadata } from 'next';

import { SecurityScreen } from '../../../_components/security-screen';

export const metadata: Metadata = { title: 'Security settings' };

export default function SecuritySettingsPage() {
  return <SecurityScreen />;
}
