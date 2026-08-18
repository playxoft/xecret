'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage, isApiError, POST_SIGN_IN_PATH, SIGN_IN_PATH } from '@/lib/api';
import { PinInput } from '@/components/auth/pin-input';
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

  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length === PIN_LENGTH && confirm !== pin;
  const ready = token !== null && pin.length === PIN_LENGTH && confirm === pin;

  async function submit() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);

    try {
      await api.post(
        '/auth/pin/reset/confirm',
        { token, pin },
        // Suppressed so a 401 lands in the branch below instead of bouncing to
        // sign-in and losing the token from the URL.
        { redirectOnUnauthenticated: false },
      );
      router.replace(POST_SIGN_IN_PATH);
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'unauthenticated') {
        setNeedsSignIn(true);
        setBusy(false);
        return;
      }

      const fields = isApiError(cause) ? cause.fieldErrors() : {};
      setError(fields['pin'] ?? errorMessage(cause));
      setPin('');
      setConfirm('');
      setBusy(false);
    }
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <p className="text-fg-muted text-center text-sm font-medium">New PIN</p>
          <PinInput
            label="New PIN"
            value={pin}
            onChange={(next) => {
              setPin(next);
              setError(null);
            }}
            disabled={busy}
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-fg-muted text-center text-sm font-medium">Enter it again</p>
          <PinInput
            label="Confirm PIN"
            value={confirm}
            onChange={(next) => {
              setConfirm(next);
              setError(null);
            }}
            onComplete={() => void submit()}
            disabled={busy || pin.length !== PIN_LENGTH}
            invalid={mismatch}
          />
        </div>

        {mismatch ? (
          <p role="alert" className="text-danger-text text-center text-sm">
            Those two PINs are different.
          </p>
        ) : error !== null ? (
          <p role="alert" className="text-danger-text text-center text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
          Set my PIN
        </Button>
      </form>
    </AuthCard>
  );
}
