import type { Metadata } from 'next';

import { DangerScreen } from '../../../_components/danger-screen';

export const metadata: Metadata = { title: 'Danger zone' };

export default function DangerSettingsPage() {
  return <DangerScreen />;
}
