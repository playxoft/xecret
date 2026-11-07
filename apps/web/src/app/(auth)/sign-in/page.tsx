import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';

import {
  isWellFormedSsoContinueBinding,
  mintSsoContinueToken,
  SSO_CONTINUE_COOKIE_NAME,
} from '@xecret/core/auth';
import { workerContext } from '@/server/context';
import { ssoContinueKey } from '@/server/sign-in';

// From their own modules rather than the `components/ui` barrel: the barrel
// would make this page depend on every client component in the kit.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
import { signInErrorMessage } from '@/lib/sign-in-errors';
import { AuthCard } from '../_components/auth-card';
import { authScreenHref, loginHref, singleParam, ssoOrgParam } from '../_components/login-href';
import { SignInPanel } from '../_components/sign-in-panel';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to xecret.',
};

/**
 * Signing in — on this page, start to finish — and the place a failed sign-in
 * comes back to.
 *
 * Email and password, or a six-digit code emailed to the address, are typed
 * here and checked by the in-app sign-in routes (`SignInPanel`,
 * `server/in-app-sign-in.ts`); "Continue with Google" is one link out to Google
 * and back; "Sign in with single sign-on" leads to this same page's
 * organisation warning below. Nothing here leads to a WorkOS page.
 *
 * ── Why the ways out are links ──
 * The login route answers with a 307 to WorkOS, which sends the browser on to
 * Google or an identity provider. A `<form>` submitted to it would be held to
 * the CSP's `form-action 'self'`, and Chrome applies that directive to *every
 * redirect* a form submission follows, not only to its `action` — so the hop
 * would be blocked, silently. A plain `<a href>` is an ordinary top-level
 * navigation, which `form-action` does not govern and which the login route was
 * built to receive. Plain `<a>` rather than `next/link` for the same reason:
 * the target is a route handler that leaves the site, so there is nothing for
 * the client router to prefetch or render, and a prefetch would mint a state
 * cookie for a sign-in nobody started. (The single sign-on form is the
 * exception that proves it: it only ever reaches this page's own warning.)
 *
 * ── What is read from the URL ──
 * Every parameter is attacker-suppliable, because anybody can link here:
 *  - `next` goes through `safeRedirectPath` — the same function the login route
 *    and the API client's 401 bounce call — before it is written into a link
 *    or handed to the form, and the routes hold it to `safePostSignInPath`
 *    again at the moment they use it. A rejected value becomes `/app`, never an
 *    error: whoever followed a bad link still wanted to sign in.
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
 *    Its "Continue" link is the only thing the login route will start an
 *    organisation's single sign-on for (review round 2): it carries a
 *    five-minute token, an HMAC over the slug, the moment, and the random
 *    binding cookie the login route handed this browser when it sent it here.
 *    Minted here, on the server, from a cookie no script and no other site
 *    can read — so a token is good only in the browser that was shown this
 *    page. A browser that arrived without a binding (this page typed or
 *    bookmarked) gets a link without one; the login route then hands it a
 *    binding and sends it back here, and the second "Continue" goes through.
 *
 * Read here, on the server, and handed to the panel as props: reading them in
 * the browser with `useSearchParams` would put a Suspense boundary around the
 * whole form for no gain.
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams;
  const next = safeRedirectPath(singleParam(params.next), POST_SIGN_IN_PATH);
  const error = signInErrorMessage(singleParam(params.error));
  const ssoOrg = ssoOrgParam(singleParam(params.org));

  if (ssoOrg !== null) {
    const continueToken = await ssoContinueTokenFor(ssoOrg);
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
            <a href={loginHref({ next, org: ssoOrg, continueToken })}>
              Continue with single sign-on
            </a>
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
      <SignInPanel mode="sign-in" next={next} initialError={error} />
    </AuthCard>
  );
}

/**
 * The "Continue" token for `slug`, bound to the binding cookie this browser
 * holds — or `null` when it holds none (the login route will hand it one) or
 * the deployment cannot mint one (it cannot sign anybody in either, and the
 * login route will say so).
 */
async function ssoContinueTokenFor(slug: string): Promise<string | null> {
  const binding = (await cookies()).get(SSO_CONTINUE_COOKIE_NAME)?.value;
  if (!isWellFormedSsoContinueBinding(binding)) return null;
  try {
    const { env } = await workerContext();
    return await mintSsoContinueToken(await ssoContinueKey(env), {
      slug,
      binding,
      issuedAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    return null;
  }
}
