'use client';

import { useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { errorMessage, isApiError } from '@/lib/api';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
// From their own modules rather than the `components/ui` barrel, as the pages
// do: these forms are all the client code the sign-in screens ship.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { EyeIcon, EyeOffIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

/**
 * The pieces the sign-in, sign-up and password-reset forms share: the form's
 * own state (busy, the banner, the problem beside each field), the fields that
 * are the same on every screen, and the way out once a server says where to go.
 *
 * ── Never kept ──
 * A password, a code or a reset token lives in a form's state until the
 * request that carries it, and nowhere else: never logged, never put in a URL,
 * never stored. Each field tells a password manager and a phone keyboard what
 * it holds — `current-password` to sign in, `new-password` wherever one is
 * chosen, `one-time-code` for the emailed code — so they offer the right thing.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deliberately permissive. Whether an address exists is answered by the
 * email that arrives, and a strict pattern's only effect is refusing the
 * valid addresses it did not anticipate.
 */
export function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(trimmed)) return 'That doesn’t look like an email address.';
  return null;
}

/** A pasted code arrives with spaces or a newline as often as not. */
export function normalisedCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * A full document load, not a client-side push: the session cookie has only
 * just been set, and everything rendered so far was rendered for nobody.
 * Held to a same-origin path once more on the way out, whatever the server
 * said.
 */
export function leaveFor(redirect: unknown): void {
  const target = safeRedirectPath(
    typeof redirect === 'string' ? redirect : null,
    POST_SIGN_IN_PATH,
  );
  window.location.assign(target);
}

/**
 * One form's request state: whether it is waiting, the sentence above it, a
 * success note, and the problem beside each field.
 *
 * `visibleFields` names the fields the current step shows. A server problem
 * with any other field (`next`, a reset link's token, the body as a whole) is
 * the page's problem, not the person's, and is said above the form instead.
 */
export function useAuthForm(initialError: string | null = null) {
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  /** Starts a request: clears what the last one said, unless the form is already busy. */
  function begin(local: Record<string, string>): boolean {
    if (busy) return false;
    setProblems(local);
    if (Object.keys(local).length > 0) return false;
    setBanner(null);
    setNotice(null);
    setBusy(true);
    return true;
  }

  function fail(cause: unknown, visibleFields: readonly string[]) {
    setBusy(false);
    setNotice(null);
    if (isApiError(cause) && cause.fields.length > 0) {
      const fields = cause.fieldErrors();
      setProblems(fields);
      setBanner(visibleFields.some((name) => name in fields) ? null : errorMessage(cause));
      return;
    }
    setProblems({});
    setBanner(errorMessage(cause));
  }

  /** Clears everything the form says, for a step that starts afresh. */
  function clear() {
    setBanner(null);
    setNotice(null);
    setProblems({});
  }

  const messages = (
    <>
      {banner !== null ? <Alert tone="danger">{banner}</Alert> : null}
      {notice !== null ? <Alert tone="success">{notice}</Alert> : null}
    </>
  );

  return {
    busy,
    setBusy,
    banner,
    setBanner,
    notice,
    setNotice,
    problems,
    setProblems,
    begin,
    fail,
    clear,
    messages,
  };
}

/** The address field, as every one of these forms asks for it. */
export function EmailField({
  value,
  onChange,
  error,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return (
    <Field label="Email" error={error}>
      <Input
        type="email"
        name="email"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // `username` everywhere, a new account included: it is what a
        // password manager files the password under.
        autoComplete="username"
        inputMode="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="you@company.com"
        disabled={disabled}
        autoFocus={autoFocus}
      />
    </Field>
  );
}

/** The emailed six-digit code, as a one-time code and never as a password. */
export function CodeField({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
}) {
  return (
    <Field label="Code from the email" hint="Six digits. Spaces don’t matter." error={error}>
      <Input
        name="code"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="one-time-code"
        inputMode="numeric"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        maxLength={16}
        className="font-mono tracking-widest"
        placeholder="123456"
        disabled={disabled}
      />
    </Field>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-line h-px flex-1" />
      <span className="text-fg-subtle text-sm">or</span>
      <span className="bg-line h-px flex-1" />
    </div>
  );
}

const TEXT_LINK_CLASS =
  'text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg rounded-sm text-sm underline underline-offset-4 transition-colors';

/** A button that reads as a link: a secondary way forward, never the main one. */
export function TextButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${TEXT_LINK_CLASS} disabled:cursor-not-allowed disabled:opacity-55`}
    >
      {children}
    </button>
  );
}

/**
 * A link that reads like {@link TextButton}. A plain `<a>`: the screens it
 * joins are server pages that read their own query, and nothing about them is
 * worth a client-side prefetch.
 */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={TEXT_LINK_CLASS}>
      {children}
    </a>
  );
}

interface PasswordInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** `current-password` to sign in; `new-password` wherever one is being chosen. */
  autoComplete: 'current-password' | 'new-password';
}

/**
 * A password field with a reveal toggle. It always starts masked, and the
 * toggle reports its state with `aria-pressed` so it is usable without seeing
 * the icon change. A masked field on a phone keyboard is where most sign-in
 * failures come from.
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
