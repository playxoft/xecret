import type { Metadata } from 'next';

import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { AuthCard } from '../../_components/auth-card';
import { singleParam } from '../../_components/login-href';
import { ForgotPasswordPanel } from '../../_components/password-reset-panel';

export const metadata: Metadata = {
  title: 'Reset your password',
  description: 'Get a link to choose a new xecret password.',
};

/**
 * "Forgot password?" — asking for a reset link (`ForgotPasswordPanel`,
 * `server/password-reset.ts`).
 *
 * Under `/sign-in/` rather than at `/forgot-password`: that path has been a
 * permanent redirect to `/sign-in` for the Firebase-era emails still in
 * inboxes, and a browser that has followed one remembers a 308 for good — a
 * page there would be unreachable for exactly the people who once reset a
 * password. (`/forgot-password` now redirects here; a browser holding the old
 * answer lands on `/sign-in`, one click away — `next.config.ts`.) Being under
 * `/sign-in/` also makes it a sign-in screen for `safePostSignInPath` and for
 * the API client's 401 bounce.
 *
 * `next` is only carried back to the sign-in link: the reset itself goes
 * through an email, and the link WorkOS sends cannot carry it.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: PageProps<'/sign-in/forgot-password'>) {
  const params = await searchParams;
  const next = safeRedirectPath(singleParam(params.next), POST_SIGN_IN_PATH);

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email address you sign in with, and we’ll email you a link to choose a new password."
    >
      <ForgotPasswordPanel next={next} />
    </AuthCard>
  );
}
