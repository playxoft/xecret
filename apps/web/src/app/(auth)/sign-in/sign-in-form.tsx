'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { isFirebaseConfigured, signInWithEmail, signInWithGoogle } from '@/lib/firebase';
import type { AuthOutcome } from '@/lib/firebase';
import { Alert, Button, Field, Input } from '@/components/ui';
import { AuthCard } from '../_components/auth-card';
import {
  authErrorText,
  FirebaseConfigNotice,
  GoogleButton,
  OrDivider,
  PasswordInput,
  validateEmail,
  validatePassword,
} from '../_components/form-support';
import { VerificationNotice } from '../_components/verification-notice';

type Pending = 'none' | 'password' | 'google';

export interface SignInFormProps {
  /** Already validated as a same-origin path by the page. */
  next: string;
}

export function SignInForm({ next }: SignInFormProps) {
  const configured = isFirebaseConfigured();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>('none');
  const [unverified, setUnverified] = useState<string | null>(null);

  /**
   * A full document load, not a client-side push.
   *
   * The session cookie has only just been set. Every Server Component above
   * this point was rendered for an anonymous request, and the router would
   * happily reuse those payloads. Throwing the document away is the only way
   * to guarantee the next render sees the new session.
   */
  function goToApp() {
    window.location.assign(next);
  }

  function handleOutcome(outcome: AuthOutcome) {
    if (outcome.status === 'signed-in') {
      goToApp();
    } else {
      setUnverified(outcome.email);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Re-entrancy guard on top of the disabled button: a second submit can
    // still arrive from the Enter key between the click and the re-render.
    if (pending !== 'none') return;

    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    if (emailError || passwordError) {
      setFieldErrors({
        ...(emailError ? { email: emailError } : {}),
        ...(passwordError ? { password: passwordError } : {}),
      });
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setPending('password');
    try {
      handleOutcome(await signInWithEmail(email.trim(), password));
    } catch (cause) {
      setFormError(authErrorText(cause));
      setPending('none');
    }
  }

  async function onGoogle() {
    if (pending !== 'none') return;
    setFormError(null);
    setPending('google');
    try {
      handleOutcome(await signInWithGoogle());
    } catch (cause) {
      setFormError(authErrorText(cause));
    } finally {
      setPending('none');
    }
  }

  if (unverified !== null) {
    return (
      <AuthCard title="Check your email" description="One more step before you can sign in.">
        <VerificationNotice email={unverified} onVerified={goToApp} />
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
            href="/sign-up"
            className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
          >
            Create an account
          </Link>
        </>
      }
    >
      {configured ? (
        <div className="flex flex-col gap-4">
          <GoogleButton
            onClick={() => void onGoogle()}
            loading={pending === 'google'}
            disabled={pending === 'password'}
            label="Continue with Google"
          />

          <OrDivider />

          {/* `noValidate` hands validation to us. The browser's own bubbles
              cannot be styled, are not announced consistently, and disappear
              on the next keystroke. */}
          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}

            <Field label="Email" error={fieldErrors.email}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="you@company.com"
                disabled={pending !== 'none'}
              />
            </Field>

            <Field label="Password" error={fieldErrors.password}>
              <PasswordInput
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={pending !== 'none'}
              />
            </Field>

            <div className="-mt-1 flex justify-end">
              <Link
                href="/forgot-password"
                className="text-fg-muted hover:text-fg rounded-sm text-sm"
              >
                Forgot your password?
              </Link>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={pending === 'password'}
              disabled={pending === 'google'}
            >
              Sign in
            </Button>
          </form>
        </div>
      ) : (
        <FirebaseConfigNotice />
      )}
    </AuthCard>
  );
}
