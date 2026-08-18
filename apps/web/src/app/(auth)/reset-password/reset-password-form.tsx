'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  checkPasswordResetCode,
  completePasswordReset,
  isFirebaseConfigured,
} from '@/lib/firebase';
import { Alert, Button, CheckCircleIcon, Field, Skeleton } from '@/components/ui';
import { AuthCard } from '../_components/auth-card';
import {
  authErrorText,
  FirebaseConfigNotice,
  PasswordInput,
  validatePassword,
} from '../_components/form-support';

type Stage =
  | { kind: 'checking' }
  | { kind: 'ready'; email: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'done' };

export interface ResetPasswordFormProps {
  /** Firebase's one-time action code, or null when the link had none. */
  oobCode: string | null;
}

export function ResetPasswordForm({ oobCode }: ResetPasswordFormProps) {
  const configured = isFirebaseConfigured();

  // A link with no code is decided before the first render — there is nothing
  // to await, so there is nothing for an effect to do.
  const [stage, setStage] = useState<Stage>(() =>
    oobCode === null
      ? { kind: 'invalid', message: 'This link is incomplete. Request a new password reset email.' }
      : { kind: 'checking' },
  );
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The code is validated before the form is shown, so an expired link fails
  // immediately rather than after the user has chosen and typed a password.
  useEffect(() => {
    if (!configured || oobCode === null) return;

    let cancelled = false;
    checkPasswordResetCode(oobCode)
      .then((email) => {
        if (!cancelled) setStage({ kind: 'ready', email });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setStage({ kind: 'invalid', message: authErrorText(cause) });
      });

    return () => {
      cancelled = true;
    };
  }, [oobCode, configured]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || oobCode === null) return;

    const passwordError = validatePassword(password);
    if (passwordError) {
      setFieldError(passwordError);
      return;
    }

    setFieldError(null);
    setFormError(null);
    setSaving(true);
    try {
      await completePasswordReset(oobCode, password);
      setStage({ kind: 'done' });
    } catch (cause) {
      setFormError(authErrorText(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!configured) {
    return (
      <AuthCard title="Choose a new password">
        <FirebaseConfigNotice />
      </AuthCard>
    );
  }

  if (stage.kind === 'done') {
    return (
      <AuthCard title="Password updated">
        <div className="flex flex-col gap-4">
          <div className="border-success-line bg-success-tint text-success-text grid size-10 place-items-center rounded-lg border">
            <CheckCircleIcon className="size-5" />
          </div>
          <p className="text-fg-muted text-sm leading-6">
            Your password has been changed. Existing xecret sessions on other devices are unaffected
            — sign out everywhere from your account settings if you believe one was compromised.
          </p>
          <Button asChild variant="primary" size="lg" className="w-full">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (stage.kind === 'invalid') {
    return (
      <AuthCard
        title="This link no longer works"
        footer={
          <Link
            href="/forgot-password"
            className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
          >
            Request a new link
          </Link>
        }
      >
        <Alert tone="danger">{stage.message}</Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description={
        stage.kind === 'ready' ? (
          <>
            For <span className="text-fg font-medium">{stage.email}</span>.
          </>
        ) : undefined
      }
      footer={
        <Link
          href="/sign-in"
          className="text-fg decoration-line-strong hover:decoration-fg rounded-sm font-medium underline underline-offset-4 transition-colors"
        >
          Back to sign in
        </Link>
      }
    >
      {stage.kind === 'checking' ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-11 w-full" />
          <span className="sr-only">Checking your reset link</span>
        </div>
      ) : (
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}

          <Field
            label="New password"
            error={fieldError}
            hint="At least 8 characters. Length beats punctuation — use a passphrase."
          >
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={saving}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={saving}>
            Update password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
