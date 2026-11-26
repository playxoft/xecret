import type { Metadata } from 'next';

import { DevicesSettings } from '../../../_components/security-screen';

export const metadata: Metadata = { title: 'Signed-in devices' };

export default function DevicesSettingsPage() {
  return <DevicesSettings />;
}
