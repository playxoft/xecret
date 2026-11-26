import type { Metadata } from 'next';

import { SignInSettings } from '../../../_components/security-screen';

export const metadata: Metadata = { title: 'Password & sign-in' };

export default function SignInSettingsPage() {
  return <SignInSettings />;
}
