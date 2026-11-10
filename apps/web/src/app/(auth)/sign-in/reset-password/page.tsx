import type { Metadata } from 'next';

import { MAX_RESET_TOKEN_LENGTH, RESET_TOKEN_PATTERN } from '@/server/workos';
import { AuthCard } from '../../_components/auth-card';
import { singleParam } from '../../_components/login-href';
import { ResetPasswordPanel } from '../../_components/password-reset-panel';

export const metadata: Metadata = {
  title: 'Choose a new password',
  description: 'Choose a new password for your xecret account.',
  // The URL carries a token that sets a password: no index, and no referrer
  // for anything this page loads.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * Where the emailed reset link lands: `/sign-in/reset-password?token=…`.
 *
 * **This URL is a WorkOS dashboard setting** — the environment's password
 * reset URL (Applications → the application → Redirects), whose default is
 * AuthKit's own reset page. It must be set to this path on this deployment's
 * origin in each environment, or the email leads to AuthKit
 * (`docs/operations/workos-environments.md` §5). Under `/sign-in/`, not at
 * `/reset-password`, because that path is a permanent redirect for the
 * Firebase-era links (`next.config.ts`).
 *
 * ── The token ──
 * Read here, on the server, and held to shape — bounded, URL-safe — before it
 * is handed to the form; anything else is no token at all, and the form says
 * the link is incomplete. The form drops it from the address bar as soon as it
 * runs, and the page sends no referrer. It is not checked here: only WorkOS can
 * say whether it is good, and asking it before the person has chosen a
 * password would spend a request on every link preview a mail client makes.
 */
export default async function ResetPasswordPage({
  searchParams,
}: PageProps<'/sign-in/reset-password'>) {
  const params = await searchParams;
  const raw = singleParam(params.token);
  const token =
    raw !== null && raw.length <= MAX_RESET_TOKEN_LENGTH && RESET_TOKEN_PATTERN.test(raw)
      ? raw
      : null;

  return (
    <AuthCard
      title="Choose a new password"
      description="Pick a password you don’t use anywhere else. You’ll sign in with it next."
    >
      <ResetPasswordPanel token={token} />
    </AuthCard>
  );
}
