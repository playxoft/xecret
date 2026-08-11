'use client';

import { useState } from 'react';

import { resendVerificationEmail, retrySessionAfterVerification } from '@/lib/firebase';
import { Alert, Button, MailIcon } from '@/components/ui';
import { authErrorText } from './form-support';

export interface VerificationNoticeProps {
  email: string;
  /** Called once the address is verified and a session exists. */
  onVerified: () => void;
}

/**
 * Shown when Firebase authenticated the user but their address is unverified.
 *
 * No xecret session exists at this point and none is created here: the server
 * rejects an unverified token outright, so this screen is the client half of a
 * rule the API already enforces rather than a check the UI could be talked out
 * of.
 */
export function VerificationNotice({ email, onVerified }: VerificationNoticeProps) {
  const [resent, setResent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setSending(true);
    setError(null);
    try {
      const sent = await resendVerificationEmail();
      if (sent) {
        setResent(true);
      } else {
        setError('Your sign-in has expired. Sign in again to request a new link.');
      }
    } catch (cause) {
      setError(authErrorText(cause));
    } finally {
      setSending(false);
    }
  }

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const outcome = await retrySessionAfterVerification();
      if (outcome === null) {
        setError('Your sign-in has expired. Sign in again to continue.');
      } else if (outcome.status === 'signed-in') {
        onVerified();
      } else {
        setError('That address is still unverified. Open the link in the email, then try again.');
      }
    } catch (cause) {
      setError(authErrorText(cause));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border-accent-line bg-accent-tint text-accent-text grid size-10 place-items-center rounded-lg border">
        <MailIcon className="size-5" />
      </div>

      <div>
        <p className="text-fg text-sm leading-6">
          Confirm your email address to finish signing in. We sent a link to{' '}
          <span className="text-fg font-medium">{email}</span>.
        </p>
        <p className="text-fg-muted mt-2 text-sm leading-6">
          Verification is required before an account can hold secrets — it is what ties an
          organisation invitation to a mailbox someone actually controls.
        </p>
      </div>

      {resent ? <Alert tone="success">A new link is on its way.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" onClick={check} loading={checking} disabled={sending}>
          I&rsquo;ve verified — continue
        </Button>
        <Button variant="ghost" onClick={resend} loading={sending} disabled={checking}>
          Resend the email
        </Button>
      </div>
    </div>
  );
}
