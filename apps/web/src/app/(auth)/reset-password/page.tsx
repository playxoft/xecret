import type { Metadata } from 'next';

import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Choose a new password',
  description: 'Set a new password for your xecret account.',
  // The URL of this page carries a single-use action code. Keeping it out of
  // search indexes costs nothing and stops a leaked link being crawled.
  robots: { index: false, follow: false },
};

/**
 * Firebase's email links arrive as
 * `/reset-password?mode=resetPassword&oobCode=…&apiKey=…`. Only `oobCode` is
 * used; the rest is ignored rather than trusted.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const params = await searchParams;
  const oobCode = typeof params.oobCode === 'string' ? params.oobCode : null;

  return <ResetPasswordForm oobCode={oobCode} />;
}
