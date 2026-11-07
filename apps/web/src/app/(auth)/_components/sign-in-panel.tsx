'use client';

import { useState } from 'react';
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { safeRedirectPath } from '@/lib/redirect-path';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
// From their own modules rather than the `components/ui` barrel, as the pages
// do: this panel is all the client code the sign-in screens ship.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { EyeIcon, EyeOffIcon, GoogleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { LOGIN_ROUTE, loginHref } from './login-href';

/**
 * Signing in, and signing up, on xecret's own page.
 *
 * Everything a person does here stays on this site except "Continue with
 * Google", which is one link out to Google by way of the login route. A
 * password, or a six-digit code xecret has WorkOS email, is posted to the
 * in-app sign-in routes (`server/in-app-sign-in.ts`) by `fetch`, and the
 * answer says where to go: the destination with a session, or the
 * "Continue as …?" confirmation for a sign-in held back. Nothing here talks
 * to WorkOS, and the browser never loads a WorkOS page.
 *
 * ── Two modes ──
 *  - **Sign in**: email and password first — accounts brought from Firebase
 *    have one — with "email me a code instead" one click away, which is also
 *    the answer to a forgotten password. A password sign-in to an address
 *    WorkOS has not verified asks for the code WorkOS emails to it before
 *    anything is signed in.
 *  - **Sign up**: an email, then the code — no password to choose. The code
 *    proves the address, and WorkOS makes the account's user for an address it
 *    has not seen, so this is the whole of signing up. An address that already
 *    has an account is simply signed in; the page never says which it was.
 *
 * ── Errors ──
 * The routes answer the API's error envelope with the same sentence
 * `/sign-in?error=` shows for the same refusal (`lib/sign-in-errors.ts`), so
 * the page shows `message` and nothing else; a wrong password or code comes
 * back naming its field, and is shown beside it. `initialError` is the
 * sentence for a `?error=` the server page read — a Google or single sign-on
 * attempt that came back refused — shown until the next attempt replaces it.
 *
 * ── Never kept ──
 * The password and codes live in this component's state until the request
 * that carries them, and nowhere else: never logged, never put in a URL, never
 * stored. The password field says `current-password` and the code fields
 * `one-time-code`, so a password manager and the phone's keyboard offer the
 * right thing.
 */

export type SignInMode = 'sign-in' | 'sign-up';

export interface SignInPanelProps {
  mode: SignInMode;
  /** Already held to `safeRedirectPath` by the page. */
  next: string;
  /** The sentence for the page's `?error=`, or `null`. */
  initialError?: string | null;
}

type Step =
  | { kind: 'password' }
  | { kind: 'code-request' }
  | { kind: 'code-entry'; email: string }
  | { kind: 'verify-email'; email: string; pendingToken: string };

/** What the in-app sign-in routes answer on success. */
interface SignInAnswer {
  redirect?: unknown;
  step?: unknown;
  pendingToken?: unknown;
}

export const SIGN_IN_ROUTES = {
  password: '/api/auth/sign-in/password',
  sendCode: '/api/auth/sign-in/code',
  verifyCode: '/api/auth/sign-in/code/verify',
  verifyEmail: '/api/auth/sign-in/verify-email',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deliberately permissive. Whether an address exists is answered by the
 * email that arrives, and a strict pattern's only effect is refusing the
 * valid addresses it did not anticipate.
 */
function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(trimmed)) return 'That doesn’t look like an email address.';
  return null;
}

/** A pasted code arrives with spaces or a newline as often as not. */
function normalisedCode(value: string): string {
  return value.replace(/\s+/g, '');
}

export function SignInPanel({ mode, next, initialError = null }: SignInPanelProps) {
  const [step, setStep] = useState<Step>(
    mode === 'sign-in' ? { kind: 'password' } : { kind: 'code-request' },
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  function reset(nextStep: Step) {
    setStep(nextStep);
    setCode('');
    setBanner(null);
    setNotice(null);
    setProblems({});
  }

  /**
   * A full document load, not a client-side push: the session cookie has only
   * just been set, and everything rendered so far was rendered for nobody.
   * Held to a same-origin path once more on the way out, whatever the server
   * said. `busy` stays set: the page is leaving.
   */
  function go(redirect: unknown) {
    const target = safeRedirectPath(
      typeof redirect === 'string' ? redirect : null,
      POST_SIGN_IN_PATH,
    );
    window.location.assign(target);
  }

  function fail(cause: unknown) {
    setBusy(false);
    setNotice(null);
    if (isApiError(cause) && cause.fields.length > 0) {
      const fields = cause.fieldErrors();
      setProblems(fields);
      // A problem with a field this step does not show (`next`, the body as a
      // whole) is the page's problem, not the person's: say it above.
      if (!['email', 'password', 'code'].some((name) => name in fields)) {
        setBanner(errorMessage(cause));
      } else {
        setBanner(null);
      }
      return;
    }
    setProblems({});
    setBanner(errorMessage(cause));
  }

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

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local: Record<string, string> = {};
    const emailError = emailProblem(email);
    if (emailError !== null) local['email'] = emailError;
    if (password.length === 0) local['password'] = 'Enter your password.';
    if (!begin(local)) return;

    const address = email.trim();
    try {
      const answer = await api.post<SignInAnswer>(
        SIGN_IN_ROUTES.password,
        { email: address, password, next },
        { redirectOnUnauthenticated: false },
      );
      if (answer.step === 'verify-email' && typeof answer.pendingToken === 'string') {
        setPassword('');
        setBusy(false);
        reset({ kind: 'verify-email', email: address, pendingToken: answer.pendingToken });
        return;
      }
      go(answer.redirect);
    } catch (cause) {
      fail(cause);
    }
  }

  async function sendCode(address: string, resend: boolean) {
    try {
      await api.post<void>(
        SIGN_IN_ROUTES.sendCode,
        { email: address },
        { redirectOnUnauthenticated: false },
      );
      setBusy(false);
      if (resend) {
        setCode('');
        setProblems({});
        setNotice('We’ve sent a new code. If more than one arrives, use the newest.');
      } else {
        reset({ kind: 'code-entry', email: address });
      }
    } catch (cause) {
      fail(cause);
    }
  }

  async function submitCodeRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local: Record<string, string> = {};
    const emailError = emailProblem(email);
    if (emailError !== null) local['email'] = emailError;
    if (!begin(local)) return;
    await sendCode(email.trim(), false);
  }

  async function resendCode(address: string) {
    if (!begin({})) return;
    await sendCode(address, true);
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'code-entry' && step.kind !== 'verify-email') return;
    const typed = normalisedCode(code);
    const local: Record<string, string> = {};
    if (!/^[0-9]{6}$/.test(typed)) local['code'] = 'Enter the six-digit code from the email.';
    if (!begin(local)) return;

    try {
      const answer =
        step.kind === 'code-entry'
          ? await api.post<SignInAnswer>(
              SIGN_IN_ROUTES.verifyCode,
              { email: step.email, code: typed, next },
              { redirectOnUnauthenticated: false },
            )
          : await api.post<SignInAnswer>(
              SIGN_IN_ROUTES.verifyEmail,
              { pendingToken: step.pendingToken, code: typed, next },
              { redirectOnUnauthenticated: false },
            );
      go(answer.redirect);
    } catch (cause) {
      fail(cause);
    }
  }

  const messages = (
    <>
      {banner !== null ? <Alert tone="danger">{banner}</Alert> : null}
      {notice !== null ? <Alert tone="success">{notice}</Alert> : null}
    </>
  );

  if (step.kind === 'code-entry' || step.kind === 'verify-email') {
    const verifying = step.kind === 'verify-email';
    return (
      <div className="flex flex-col gap-5">
        {messages}
        <p className="text-fg-muted text-sm leading-6">
          {verifying ? (
            <>
              First, confirm your email address. We’ve emailed a six-digit code to{' '}
              <span className="text-fg font-medium break-all">{step.email}</span>.
            </>
          ) : (
            <>
              We’ve emailed a six-digit code to{' '}
              <span className="text-fg font-medium break-all">{step.email}</span>. It expires in ten
              minutes.
            </>
          )}
        </p>

        {/* `noValidate` hands validation to us: the browser's own bubbles
            cannot be styled, are announced inconsistently, and vanish on the
            next keystroke. */}
        <form
          noValidate
          onSubmit={(event) => void submitCode(event)}
          className="flex flex-col gap-4"
        >
          <Field
            label="Code from the email"
            hint="Six digits. Spaces don’t matter."
            error={problems['code'] ?? null}
          >
            <Input
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              maxLength={16}
              className="font-mono tracking-widest"
              placeholder="123456"
              disabled={busy}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            {verifying ? 'Confirm and sign in' : mode === 'sign-up' ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {verifying ? (
            <TextButton onClick={() => reset({ kind: 'password' })} disabled={busy}>
              Start again
            </TextButton>
          ) : (
            <>
              <TextButton onClick={() => void resendCode(step.email)} disabled={busy}>
                Send a new code
              </TextButton>
              <TextButton onClick={() => reset({ kind: 'code-request' })} disabled={busy}>
                Use a different email
              </TextButton>
            </>
          )}
        </div>
        {verifying ? (
          <p className="text-fg-subtle text-sm leading-6">
            Didn’t get it? Check your spam folder, or start again and sign in once more to send
            another.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {messages}

      <Button variant="secondary" size="lg" className="w-full" asChild>
        {/* A plain link, not `next/link` and not a form: the login route
            answers with a redirect to Google by way of WorkOS, a form
            following it would be stopped by the CSP's `form-action 'self'`,
            and a prefetch would mint a state cookie for a sign-in nobody
            started (`(auth)/sign-in/page.tsx`). */}
        <a href={loginHref({ next, provider: 'google' })}>
          <GoogleIcon className="size-4" />
          Continue with Google
        </a>
      </Button>

      <OrDivider />

      {step.kind === 'password' ? (
        <form
          noValidate
          onSubmit={(event) => void submitPassword(event)}
          className="flex flex-col gap-4"
        >
          <Field label="Email" error={problems['email'] ?? null}>
            <Input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@company.com"
              disabled={busy}
            />
          </Field>

          <Field label="Password" error={problems['password'] ?? null}>
            <PasswordInput
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </Field>

          <div className="-mt-1 flex justify-end">
            <TextButton onClick={() => reset({ kind: 'code-request' })} disabled={busy}>
              Forgot your password? Email me a code
            </TextButton>
          </div>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
      ) : (
        <form
          noValidate
          onSubmit={(event) => void submitCodeRequest(event)}
          className="flex flex-col gap-4"
        >
          <p className="text-fg-muted text-sm leading-6">
            {mode === 'sign-up'
              ? 'Enter your email and we’ll send you a six-digit code. There’s no password to choose: next time, sign in with a new code or with Google.'
              : 'We’ll email you a six-digit code. Enter it here to sign in — no password needed.'}
          </p>

          <Field label="Email" error={problems['email'] ?? null}>
            <Input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete={mode === 'sign-up' ? 'email' : 'username'}
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@company.com"
              disabled={busy}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Email me a code
          </Button>

          {mode === 'sign-in' ? (
            <div className="flex justify-center">
              <TextButton onClick={() => reset({ kind: 'password' })} disabled={busy}>
                Sign in with a password instead
              </TextButton>
            </div>
          ) : null}
        </form>
      )}

      {mode === 'sign-in' ? <SingleSignOn next={next} /> : null}
    </div>
  );
}

/**
 * "Sign in with single sign-on" — for an organisation that signs its people in
 * through its own identity provider.
 *
 * A plain `GET` form to the login route, with the organisation's address on
 * xecret (its slug), and no script. The login route sends any `org=` it was
 * not given by the warning page's own button to that page first
 * (`/sign-in?org=…`, the deep link's login-CSRF defence), so this costs one
 * confirmation, and the identity provider is reached only from there. A form
 * is fine here where a form to AuthKit was not: both hops it follows — to the
 * login route and back to this page — are on this origin, which is all
 * `form-action 'self'` asks. An address that is no organisation's with single
 * sign-on comes back as `?error=sso-not-found`, never as AuthKit's page.
 */
function SingleSignOn({ next }: { next: string }) {
  return (
    <details className="group border-line rounded-lg border">
      <summary className="text-fg-muted hover:text-fg cursor-pointer list-none rounded-lg px-3.5 py-3 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-3">
          Sign in with single sign-on
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </span>
      </summary>
      <form method="get" action={LOGIN_ROUTE} className="flex flex-col gap-4 px-3.5 pb-4">
        <Field
          label="Your organisation’s address on xecret"
          hint="The name after /app/ in your dashboard’s address — for example, acme-corp. Your administrator can tell you."
        >
          <Input
            name="org"
            required
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="acme-corp"
          />
        </Field>
        {next !== POST_SIGN_IN_PATH ? <input type="hidden" name="next" value={next} /> : null}
        <Button type="submit" variant="secondary" className="w-full">
          Continue with single sign-on
        </Button>
      </form>
    </details>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-line h-px flex-1" />
      <span className="text-fg-subtle text-sm">or</span>
      <span className="bg-line h-px flex-1" />
    </div>
  );
}

/** A button that reads as a link: a secondary way forward, never the main one. */
function TextButton({
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
      className="text-fg-muted hover:text-fg decoration-line-strong hover:decoration-fg rounded-sm text-sm underline underline-offset-4 transition-colors disabled:cursor-not-allowed disabled:opacity-55"
    >
      {children}
    </button>
  );
}

interface PasswordInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** A sign-in's password, for password managers. */
  autoComplete: 'current-password';
}

/**
 * A password field with a reveal toggle. It always starts masked, and the
 * toggle reports its state with `aria-pressed` so it is usable without seeing
 * the icon change. A masked field on a phone keyboard is where most sign-in
 * failures come from.
 */
function PasswordInput({ autoComplete, ...props }: PasswordInputProps) {
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
