'use client';

import { useState } from 'react';
import type { InputHTMLAttributes } from 'react';

import { isApiError } from '@/lib/api';
import { describeAuthError, firebaseConfigProblem } from '@/lib/firebase';
import { Alert, Button, EyeIcon, EyeOffIcon, GoogleIcon, Input } from '@/components/ui';

/**
 * Small pieces shared by the four authentication screens. Kept together so the
 * screens read as forms rather than as a pile of imports.
 */

/**
 * A failure's user-facing text.
 *
 * Two sources of failure meet here. `ApiError` messages come from our own
 * server and are already written for users (§3 of the API contract fixes them
 * to a safe set), so they are shown as-is. Everything else is a Firebase error
 * and goes through `describeAuthError`, which is where the anti-enumeration
 * collapsing lives.
 */
export function authErrorText(error: unknown): string {
  return isApiError(error) ? error.message : describeAuthError(error);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Deliberately permissive. The only authority on whether an address exists is
 * the email that gets delivered to it; a strict client-side pattern's only
 * measurable effect is rejecting the valid addresses it did not anticipate.
 */
export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(trimmed)) return 'That does not look like an email address.';
  return null;
}

/**
 * Length only.
 *
 * Composition rules ("one uppercase, one symbol") measurably reduce entropy by
 * pushing everyone towards the same shapes, and NIST SP 800-63B has advised
 * against them for years. Length is what matters, and a password manager —
 * which our users have — makes length free.
 */
export function validatePassword(value: string): string | null {
  if (value.length === 0) return 'Enter a password.';
  if (value.length < 8) return 'Use at least 8 characters.';
  return null;
}

export function validateName(value: string): string | null {
  return value.trim().length === 0 ? 'Enter your name.' : null;
}

export interface PasswordInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Distinguishes a new password from a login one for password managers. */
  autoComplete: 'current-password' | 'new-password';
}

/**
 * A password field with a reveal toggle.
 *
 * The toggle exists because the alternative — a "confirm password" field —
 * measurably increases typos and abandonment without improving security, and
 * because a masked field on a phone keyboard is where most sign-in failures
 * actually come from. It always starts masked, and the button reports its
 * state with `aria-pressed` so it is usable without seeing the icon change.
 */
export function PasswordInput({ autoComplete, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <Input
      {...props}
      type={visible ? 'text' : 'password'}
      autoComplete={autoComplete}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      endSlot={
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </Button>
      }
    />
  );
}

export interface GoogleButtonProps {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  label: string;
}

export function GoogleButton({ onClick, loading, disabled, label }: GoogleButtonProps) {
  return (
    <Button
      variant="secondary"
      size="lg"
      className="w-full"
      onClick={onClick}
      loading={loading}
      disabled={disabled}
    >
      <GoogleIcon className="size-4" />
      {label}
    </Button>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-line h-px flex-1" />
      <span className="text-fg-subtle text-xs">or</span>
      <span className="bg-line h-px flex-1" />
    </div>
  );
}

/**
 * Shown instead of the form when the deployment has no Firebase project.
 *
 * A self-hoster's first run lands here. Without it they get a form that fails
 * on submit with an SDK error, which reads like a bug in the product rather
 * than a missing step in their setup.
 */
export function FirebaseConfigNotice() {
  const problem = firebaseConfigProblem();
  if (problem === null) return null;

  return (
    <Alert tone="warning" title="Authentication is not configured">
      <p>
        This deployment has no usable Firebase project, so sign-in is unavailable:{' '}
        <span className="font-mono text-xs">{problem}</span>.
      </p>
      <p className="mt-2">
        Set <code className="font-mono text-xs">NEXT_PUBLIC_FIREBASE_CONFIG</code> to the JSON
        object from the Firebase console — Project settings → Your apps → SDK setup and
        configuration — then restart.
      </p>
      <p className="mt-2">
        See <code className="font-mono text-xs">.env.example</code> and{' '}
        <code className="font-mono text-xs">docs/adr/0003-firebase-as-identity-provider.md</code>.
      </p>
    </Alert>
  );
}
