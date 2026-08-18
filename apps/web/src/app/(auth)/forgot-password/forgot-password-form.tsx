'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { isFirebaseConfigured, sendPasswordReset } from '@/lib/firebase';
import { Alert, Button, Field, Input, MailIcon } from '@/components/ui';
import { AuthCard } from '../_components/auth-card';
import { authErrorText, FirebaseConfigNotice, validateEmail } from '../_components/form-support';

export function ForgotPasswordForm() {
  const configured = isFirebaseConfigured();

  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;

    const emailError = validateEmail(email);
    if (emailError) {
      setFieldError(emailError);
      return;
    }

    setFieldError(null);
    setFormError(null);
    setSending(true);
    try {
      await sendPasswordReset(email.trim());
      setSent(true);
    } catch (cause) {
      setFormError(authErrorText(cause));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <AuthCard title="Check your email" footer={<Link href="/sign-in">Back to sign in</Link>}>
        <div className="flex flex-col gap-4">
          <div className="border-accent-line bg-accent-tint text-accent-text grid size-10 place-items-center rounded-lg border">
            <MailIcon className="size-5" />
          </div>
          {/*
            The same message regardless of whether the address has an account.
            "No account with that email" would turn this form into a directory
            lookup: submit an address, learn whether that person uses xecret.
            `sendPasswordReset` swallows the not-found error for the same reason.
          */}
          <p className="text-fg text-sm leading-6">
            If <span className="font-medium">{email.trim()}</span> has an xecret account, a reset
            link is on its way. The link is valid for one hour.
          </p>
          <p className="text-fg-muted text-sm leading-6">
            Nothing arrived? Check your spam folder, then try again — and confirm you signed up with
            a password rather than Google.
          </p>
          <Button variant="secondary" onClick={() => setSent(false)}>
            Use a different address
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to choose a new one."
      footer={
        <Link
          href="/sign-in"
          className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
        >
          Back to sign in
        </Link>
      }
    >
      {configured ? (
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}

          <Field label="Email" error={fieldError}>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@company.com"
              disabled={sending}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={sending}>
            Send reset link
          </Button>
        </form>
      ) : (
        <FirebaseConfigNotice />
      )}
    </AuthCard>
  );
}
