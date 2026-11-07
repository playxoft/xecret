import type { Metadata } from 'next';
import Link from 'next/link';

import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { AuthCard } from '../_components/auth-card';
import { authScreenHref, singleParam } from '../_components/login-href';
import { SignInPanel } from '../_components/sign-in-panel';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create a free xecret account.',
};

/**
 * Account creation, on this page: an email address and the six-digit code
 * emailed to it, or Google.
 *
 * Kept as its own screen rather than folded into `/sign-in` (plan §8 Q4)
 * because it is where every "Start free" button on the public site points, and
 * somebody who clicked one should land on a page that says what they are about
 * to get, not on a page asking them to sign in to an account they do not have.
 *
 * ── Why no password ──
 * Signing up is the emailed-code flow (`SignInPanel`'s sign-up mode, WorkOS
 * Magic Auth through `server/in-app-sign-in.ts`): the code proves the address
 * in the same step that creates the account, so the verified-address gate in
 * `prepareSignIn` is met without a separate verification screen, and there is
 * no password policy, strength meter or reset flow to build for it. It also
 * answers an address that already has an account exactly as one that does not
 * — that address is simply signed in — where a password sign-up would have to
 * say "that address is taken" to somebody who may not own it.
 *
 * `next` is accepted because the sign-in screen's "Create an account" link
 * passes it on: somebody bounced from the CLI's consent screen, or following an
 * invitation, who has no account yet must still end up back there once they
 * have one. It is validated before it is written anywhere, as `/sign-in`
 * explains.
 *
 * No `?error=` surface: a refusal of anything typed here is shown in the form,
 * and a Google sign-up that comes back refused lands on `/sign-in`, which has
 * the copy for it.
 */
export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
  const params = await searchParams;
  const next = safeRedirectPath(singleParam(params.next), POST_SIGN_IN_PATH);

  return (
    <AuthCard
      title="Create your xecret account"
      description="A personal organisation is created for you on first sign-in. Invite your team whenever you're ready."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href={authScreenHref('/sign-in', next)}
            className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
          >
            Sign in
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <SignInPanel mode="sign-up" next={next} />
        <p className="text-fg-subtle text-sm leading-6">
          Joining a team? Use the address your invitation was sent to: invitations are tied to it.
        </p>
      </div>
    </AuthCard>
  );
}
