'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { POST_SIGN_IN_PATH } from '@/lib/api';
import { isFirebaseConfigured, signInWithGoogle, signUpWithEmail } from '@/lib/firebase';
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
  validateName,
  validatePassword,
} from '../_components/form-support';
import { VerificationNotice } from '../_components/verification-notice';

type Pending = 'none' | 'password' | 'google';

export function SignUpForm() {
  const configured = isFirebaseConfigured();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>('none');
  const [unverified, setUnverified] = useState<string | null>(null);

  function goToApp() {
    // See the note in the sign-in form: the session cookie is new, so the
    // document is replaced rather than client-navigated.
    window.location.assign(POST_SIGN_IN_PATH);
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
    if (pending !== 'none') return;

    const nameError = validateName(name);
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    if (nameError || emailError || passwordError) {
      setFieldErrors({
        ...(nameError ? { name: nameError } : {}),
        ...(emailError ? { email: emailError } : {}),
        ...(passwordError ? { password: passwordError } : {}),
      });
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setPending('password');
    try {
      handleOutcome(await signUpWithEmail(email.trim(), password, name.trim()));
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
      <AuthCard title="Confirm your email" description="Your account is created.">
        <VerificationNotice email={unverified} onVerified={goToApp} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your xecret account"
      description="A personal organisation is created for you on first sign-in. Invite your team whenever you're ready."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/sign-in" className="text-accent-text rounded-sm font-medium hover:underline">
            Sign in
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
            label="Sign up with Google"
          />

          <OrDivider />

          <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
            {formError ? <Alert tone="danger">{formError}</Alert> : null}

            <Field label="Name" error={fieldErrors.name}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                placeholder="Ada Lovelace"
                disabled={pending !== 'none'}
              />
            </Field>

            <Field
              label="Work email"
              error={fieldErrors.email}
              hint="Invitations are tied to this address."
            >
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

            <Field
              label="Password"
              error={fieldErrors.password}
              hint="At least 8 characters. Length beats punctuation — use a passphrase."
            >
              <PasswordInput
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                disabled={pending !== 'none'}
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={pending === 'password'}
              disabled={pending === 'google'}
            >
              Create account
            </Button>
          </form>
        </div>
      ) : (
        <FirebaseConfigNotice />
      )}
    </AuthCard>
  );
}
