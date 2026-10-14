import type { Metadata } from 'next';
import Link from 'next/link';

// From its own module rather than the `components/ui` barrel — see the note in
// `sign-in/page.tsx`.
import { Button } from '@/components/ui/button';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { AuthCard } from '../_components/auth-card';
import { authScreenHref, loginHref, singleParam } from '../_components/login-href';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create a free xecret account.',
};

/**
 * Account creation — which, since AuthKit, is sign-in with a hint.
 *
 * Kept as its own screen rather than folded into `/sign-in` (plan §8 Q4)
 * because it is where every "Start free" button on the public site points, and
 * somebody who clicked one should land on a page that says what they are about
 * to get, not on a page asking them to sign in to an account they do not have.
 * The only functional difference is `hint=sign-up`, which opens AuthKit on its
 * sign-up screen; an existing account that arrives there can still sign in, and
 * the callback treats both the same way.
 *
 * Everything `sign-in/page.tsx` says about a link rather than a form, and about
 * validating `next` before writing it into one, applies here unchanged. `next`
 * is accepted at all because the sign-in screen's "Create an account" link
 * passes it on: somebody bounced from the CLI's consent screen who has no
 * account yet must still end up back on that screen once they have one.
 *
 * No `?error=` surface: every failure, including one that began here, comes
 * back to `/sign-in`, which has the copy for it.
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
        <div className="text-fg-muted flex flex-col gap-3 text-sm leading-6">
          <p>
            You&rsquo;ll create your account on xecret&rsquo;s secure sign-in page, hosted for us by
            WorkOS — with an email and password, or with Google. Sign up with a password and
            you&rsquo;ll be asked to confirm your email address before you continue.
          </p>
          <p>
            Joining a team? Use the address your invitation was sent to: invitations are tied to it.
          </p>
        </div>

        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href={loginHref({ next, signUp: true })}>Continue to create your account</a>
        </Button>
      </div>
    </AuthCard>
  );
}
