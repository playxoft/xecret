'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, isApiError, POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/api';
import { PinChooseForm } from '@/components/auth/pin-forms';
import { Alert, Button } from '@/components/ui';
import { AuthCard } from '../_components/auth-card';

/**
 * Choosing a new PIN from an emailed link.
 *
 * ── Both credentials, or nothing ──
 * The request carries the token in its body and the session in its cookie, and
 * the server requires both to belong to the same account. So this form has two
 * ways to fail before it has even been filled in, and each gets its own answer
 * rather than a shared "something went wrong":
 *
 *  - **No token in the URL.** The link was truncated by a mail client, which
 *    happens often enough to be worth naming.
 *  - **No session.** The link was opened in a different browser from the one
 *    that is signed in. The token is preserved through the sign-in round trip
 *    via `?next=`, so the user lands back here rather than at the dashboard with
 *    the link spent and nothing to show for it.
 */
export function ResetPinForm({ token }: { token: string | null }) {
  const router = useRouter();

  const [needsSignIn, setNeedsSignIn] = useState(false);

  /**
   * The fields, the confirmation and the weak-PIN reason are `PinChooseForm`'s;
   * only the request is this page's. It was a third copy of that form until the
   * lock screen and the CLI consent screen needed the second — and a rule about
   * what makes a PIN acceptable is not a thing to keep in three places.
   */
  async function submit(pin: string) {
    try {
      await api.post(
        '/auth/pin/reset/confirm',
        { token, pin },
        // Suppressed so a 401 lands in the branch below instead of bouncing to
        // sign-in and losing the token from the URL.
        { redirectOnUnauthenticated: false },
      );
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'unauthenticated') {
        // Answered by a different screen rather than by an error under the
        // fields, so this is not re-thrown: the form is about to unmount.
        setNeedsSignIn(true);
        return;
      }
      throw cause;
    }

    router.replace(POST_SIGN_IN_PATH);
  }

  if (token === null) {
    return (
      <AuthCard
        title="That link is incomplete"
        description="The reset link is missing its token — some mail clients cut long links in half."
      >
        <Alert tone="danger" title="Nothing to reset with">
          Open the link from your email again, or request a new one from the PIN screen.
        </Alert>
        <Button variant="secondary" className="mt-4 w-full" asChild>
          <a href={POST_SIGN_IN_PATH}>Go to xecret</a>
        </Button>
      </AuthCard>
    );
  }

  if (needsSignIn) {
    // `next` carries the whole current URL, token and all, so signing in returns
    // here rather than spending the link for nothing.
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);

    return (
      <AuthCard
        title="Sign in first"
        description="This link resets the PIN on the account it was sent to, so we need to know that it is you."
      >
        <Button variant="primary" className="w-full" asChild>
          <a href={`${SIGN_IN_PATH}?next=${next}`}>Sign in and continue</a>
        </Button>
        <p className="text-fg-subtle mt-3 text-center text-sm leading-5">
          Your link is still good — you will come straight back here.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new PIN"
      description={`${PIN_LENGTH} digits. It unlocks xecret on each of your devices for 8 hours at a time.`}
    >
      <PinChooseForm submit={submit} />
    </AuthCard>
  );
}
