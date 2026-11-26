import type { Metadata } from 'next';

import { UnlockSettings } from '../../../_components/security-screen';

export const metadata: Metadata = { title: 'Unlock & auto-lock' };

export default function UnlockSettingsPage() {
  return <UnlockSettings />;
}
