import type { Metadata } from 'next';

import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = {
  title: 'Reset your password',
  description: 'Request a password reset link for your xecret account.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
