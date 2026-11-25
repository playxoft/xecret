import type { Metadata } from 'next';

import { VaultSettings } from '../../../_components/security-screen';

export const metadata: Metadata = { title: 'Vault' };

export default function VaultSettingsPage() {
  return <VaultSettings />;
}
