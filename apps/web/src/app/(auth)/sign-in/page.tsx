import type { Metadata } from 'next';
import Link from 'next/link';

// From their own modules rather than the `components/ui` barrel: this page is
// otherwise all server markup, and the barrel would make it depend on every
// client component in the kit to render one alert and one link.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { signInErrorMessage } from '@/lib/sign-in-errors';
import { AuthCard } from '../_components/auth-card';
import { authScreenHref, loginHref, singleParam, ssoOrgParam } from '../_components/login-href';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to xecret.',
};

/**
 * The door to AuthKit, and the place a failed sign-in comes back to.
 *
 * There is no form here. Email and password, Google, multi-factor, password
 * reset and single sign-on all happen on the hosted AuthKit page, so this
 * screen's whole job is one link to `GET /api/auth/login` carrying `?next=`,
 * plus the sentence explaining why the last attempt did not work.
 *
 * ── Why a link and not a form ──
 * The login route answers with a 307 to AuthKit's origin. A `<form>` submitted
 * to it would be held to the CSP's `form-action 'self'`, and Chrome applies that
 * directive to *every redirect* a form submission follows, not only to its
 * `action` — so the hop to AuthKit would be blocked, silently, on the one
 * button this page has. A plain `<a href>` is an ordinary top-level navigation,
 * which `form-action` does not govern and which the login route was built to
 * receive. Plain `<a>` rather than `next/link` for the same reason: the target
 * is a route handler that leaves the site, so there is nothing for the client
 * router to prefetch or render, and a prefetch would mint a state cookie for a
 * sign-in nobody started.
 *
 * ── What is read from the URL ──
 * Every parameter is attacker-suppliable, because anybody can link here:
 *  - `next` goes through `safeRedirectPath` — the same function the login route
 *    and the API client's 401 bounce call — before it is written into a link.
 *    A rejected value becomes `/app`, never an error: whoever followed a bad
 *    link still wanted to sign in.
 *  - `error` is only ever a key into the table in `lib/sign-in-errors.ts`. An
 *    unknown code renders nothing at all, so the parameter cannot put text of
 *    its choosing on this page.
 *  - `org` is an SSO deep link that arrived from somewhere other than this
 *    site — the login route sends those here rather than straight to the
 *    organisation's identity provider. The page names the organisation and asks
 *    the person to confirm it is theirs before continuing, because a link from
 *    elsewhere could be somebody else's organisation, wired to an identity
 *    provider that signs the visitor in as *them* (login CSRF; see the login
 *    route). Held to the slug pattern before it is printed, and never looked up
 *    here: whether the slug exists, or has SSO, is not this page's to say.
 *
 * Read here, on the server. Reading them in the browser with `useSearchParams`
 * would mean shipping a client component, and a Suspense boundary around it,
 * to render what is otherwise static markup.
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams;
  const next = safeRedirectPath(singleParam(params.next), POST_SIGN_IN_PATH);
  const error = signInErrorMessage(singleParam(params.error));
  const ssoOrg = ssoOrgParam(singleParam(params.org));

  if (ssoOrg !== null) {
    return (
      <AuthCard
        title="Sign in with single sign-on"
        description="You followed a link to sign in through an organisation’s identity provider."
      >
        <div className="flex flex-col gap-5">
          {error !== null ? <Alert tone="danger">{error}</Alert> : null}

          <Alert tone="warning" title="Check that this is your organisation">
            <p>
              This link signs you in with the single sign-on of an organisation whose address on
              xecret is <code className="font-mono font-medium">{ssoOrg}</code> — chosen by whoever
              set it up, so it proves nothing on its own. Continue only if you know that is your
              company’s organisation. If you did not expect this link, sign in the usual way
              instead.
            </p>
          </Alert>

          <Button variant="primary" size="lg" className="w-full" asChild>
            <a href={loginHref({ next, org: ssoOrg })}>Continue with single sign-on</a>
          </Button>
          <Button variant="secondary" size="lg" className="w-full" asChild>
            <a href={authScreenHref('/sign-in', next)}>Sign in another way</a>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in to xecret"
      description="Your secrets, your environments, one command away."
      footer={
        <>
          New here?{' '}
          <Link
            href={authScreenHref('/sign-up', next)}
            className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
          >
            Create an account
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error !== null ? <Alert tone="danger">{error}</Alert> : null}

        <p className="text-fg-muted text-sm leading-6">
          You&rsquo;ll continue on xecret&rsquo;s secure sign-in page, hosted for us by WorkOS, and
          sign in there with your email and password, with Google, or with your company&rsquo;s
          single sign-on. Forgotten your password? You can reset it on the same page.
        </p>

        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href={loginHref({ next })}>Continue to sign in</a>
        </Button>
      </div>
    </AuthCard>
  );
}
