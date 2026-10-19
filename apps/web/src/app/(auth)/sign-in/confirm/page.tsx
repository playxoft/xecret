import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { SIGN_IN_CONFIRMATION_COOKIE_NAME } from '@xecret/core/auth';
// From their own modules rather than the `components/ui` barrel, as the sign-in
// page does: everything else here is server markup.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { workerContext } from '@/server/context';
import { readConfirmationView } from '@/server/sign-in-confirmation';
import type { ConfirmationView } from '@/server/sign-in-confirmation';
import { AuthCard } from '../../_components/auth-card';

export const metadata: Metadata = {
  title: 'Confirm your sign-in',
  description: 'Confirm that this sign-in to xecret is yours.',
  // A page that only ever means something to the browser holding the cookie.
  robots: { index: false, follow: false },
};

/**
 * "Continue as …?" — where a sign-in the callback held back is confirmed or
 * declined (review S1; the callback's header, step 6, says when and why).
 *
 * Everything shown comes from the sealed confirmation cookie, read and verified
 * here on the server; nothing is taken from the URL, so a link to this page
 * cannot put words on it. What the page says is chosen with the attack in
 * mind: the person is looking at an account somebody else may have signed them
 * in to, so it names the account plainly, presents the organisation as the
 * *claim* it is ("an organisation calling itself …" — its owner chose the name,
 * and anybody can create one), and makes declining as easy as continuing.
 *
 * ── The address and the name are somebody else's strings ──
 * An organisation's owner chose its name, and an identity provider chose the
 * address it asserted. Either could carry a direction override that makes
 * reversed text read as a colleague's address, an invisible character that
 * makes one "Acme" a different organisation from another that looks the same, a
 * tower of combining accents that covers the sentence beside it, or simply be
 * long enough to push the explanation off the screen (review round 2). So both
 * arrive here already made inert — `inertText`: every such character replaced
 * by a visible U+FFFD, cut to length — and are rendered inside `<bdi>`, left to
 * right, so whatever direction their letters have cannot reorder the sentence
 * around them. An address with anything outside printable ASCII is also said
 * to have it, because a look-alike letter needs no special character at all.
 *
 * The form posts to `POST /api/auth/confirm` with the cookie's nonce as its
 * token — the CSRF check — and that route, not this page, decides. A plain
 * HTML form: it must work without script, and `form-action 'self'` covers it.
 */
export default async function ConfirmSignInPage() {
  const cookie = (await cookies()).get(SIGN_IN_CONFIRMATION_COOKIE_NAME)?.value;
  const { env } = await workerContext();
  const view = await readConfirmationView(env, cookie);

  if (view === null) {
    return (
      <AuthCard
        title="This sign-in has expired"
        description="A sign-in waiting for your confirmation lasts five minutes, and is used once."
      >
        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href="/sign-in">Sign in again</a>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Is this you?" description={<Explanation view={view} />}>
      <div className="flex flex-col gap-5">
        <div className="border-line bg-canvas-inset rounded-lg border px-4 py-3">
          <p className="text-fg-subtle text-sm">The account you would be signed in to</p>
          <p className="text-fg mt-0.5 font-mono text-sm font-medium break-all">
            <Inert value={view.email} />
          </p>
        </div>

        <Alert tone="warning" title="Continue only if you just signed in yourself">
          <p>
            If you did not just sign in, or this is not your account, choose{' '}
            <span className="font-medium">This isn’t me</span>. Somebody may be trying to sign you
            in to an account of theirs, so that whatever you store next ends up with them.
          </p>
          {view.emailHasNonAscii ? (
            <p className="mt-2">
              This address contains characters outside the plain Latin alphabet. Check it letter by
              letter: a look-alike letter can make a different address read like yours.
            </p>
          ) : null}
        </Alert>

        <form method="post" action="/api/auth/confirm" className="flex flex-col gap-3">
          <input type="hidden" name="confirmation" value={view.confirmation} />
          <Button
            type="submit"
            name="decision"
            value="continue"
            variant="primary"
            size="lg"
            className="w-full"
          >
            {/* Not "Continue as {address}": a button is one line, and a long
                address cut short there could show a colleague's domain and hide
                the attacker's. The address is shown whole, above. */}
            Yes, continue with this account
          </Button>
          <Button
            type="submit"
            name="decision"
            value="cancel"
            variant="secondary"
            size="lg"
            className="w-full"
          >
            This isn’t me
          </Button>
        </form>
      </div>
    </AuthCard>
  );
}

/**
 * Somebody else's string — already made inert by `inertText` — isolated, left
 * to right, so its letters cannot reorder the sentence it sits in.
 */
function Inert({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={className}>
      {value}
    </bdi>
  );
}

/** The one sentence that says what happened, in the words the attack calls for. */
function Explanation({ view }: { view: ConfirmationView }) {
  const account = <Inert value={view.email} className="text-fg font-medium break-all" />;

  if (view.sso) {
    if (view.organization === null) {
      return (
        <>
          You were signed in as {account} through the single sign-on of an organisation that is not
          set up on xecret.
        </>
      );
    }
    const claim = (
      <>
        an organisation calling itself{' '}
        <span className="text-fg font-medium break-all">
          “<Inert value={view.organization.name} />”
        </span>{' '}
        (<code className="font-mono break-all">{view.organization.slug}</code>)
      </>
    );
    // "Yet", and the sentence after it, only when continuing really does make
    // the account a member: not for an organisation that admits nobody this
    // way, nor for one that removed or suspended this account (review round 3).
    const notMember =
      view.reason !== 'not-member'
        ? ''
        : view.joins
          ? ', which this account does not belong to yet'
          : ', which this account is not an active member of';
    return (
      <>
        You were signed in as {account} through the single sign-on of {claim}
        {notMember}. {view.joins ? 'Continuing makes this account a member of it. ' : ''}
        Anybody can create an organisation and give it any name, so the name alone proves nothing.
      </>
    );
  }
  if (view.reason === 'reused-session') {
    return (
      <>
        You were signed in as {account} without being asked for anything, because this browser was
        still signed in at our sign-in provider.
      </>
    );
  }
  return <>You were signed in as {account}.</>;
}
