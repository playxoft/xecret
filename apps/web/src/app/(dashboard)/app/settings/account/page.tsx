import type { Metadata } from 'next';

import { AccountScreen } from '../../../_components/account-screen';

export const metadata: Metadata = { title: 'Account' };

export default function AccountPage() {
  return <AccountScreen />;
}
