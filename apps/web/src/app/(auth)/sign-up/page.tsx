import type { Metadata } from 'next';
import Link from 'next/link';

import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { AuthCard } from '../_components/auth-card';
import { authScreenHref, singleParam } from '../_components/login-href';
import { SignUpPanel } from '../_components/sign-up-panel';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create a free xecret account.',
};

/**
 * Account creation, on this page: an email and a password, then the six-digit
 * code emailed to the address — or Google.
 *
 * Kept as its own screen rather than folded into `/sign-in` (plan §8 Q4)
 * because it is where every "Start free" button on the public site points, and
 * somebody who clicked one should land on a page that says what they are about
 * to get, not on a page asking them to sign in to an account they do not have.
 *
 * ── The code before the password ──
 * The person types both at once; the page holds the password while the code
 * is emailed, and the server sets it only beside a right code, and only on an
 * account that sign-up created (`SignUpPanel`, `POST /api/auth/sign-up`). So
 * the code proves the address in the same request that sets the password — the
 * verified-address gate in `prepareSignIn` is met, no password ever sits on an
 * address nobody has proven — and an address that already has an account is
 * answered exactly as one that does not until the code is accepted; then it is
 * signed in to, its password untouched, and told so.
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
        <SignUpPanel next={next} />
        <p className="text-fg-subtle text-sm leading-6">
          Joining a team? Use the address your invitation was sent to: invitations are tied to it.
        </p>
      </div>
    </AuthCard>
  );
}
