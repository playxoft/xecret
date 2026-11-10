'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

import { api } from '@/lib/api';
import { POST_SIGN_IN_PATH } from '@/lib/session-hint';
// From their own modules rather than the `components/ui` barrel, as the pages
// do: these forms are all the client code the sign-in screens ship.
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { GoogleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import {
  CodeField,
  EmailField,
  emailProblem,
  leaveFor,
  normalisedCode,
  OrDivider,
  PasswordInput,
  TextButton,
  TextLink,
  useAuthForm,
} from './form-parts';
import { authScreenHref, LOGIN_ROUTE, loginHref } from './login-href';

/**
 * Signing in on xecret's own page.
 *
 * Everything a person does here stays on this site except "Continue with
 * Google", which is one link out to Google by way of the login route. The
 * email and password are posted to the in-app sign-in route
 * (`server/in-app-sign-in.ts`) by `fetch`, and the answer says where to go: the
 * destination with a session, or the "Continue as …?" confirmation for a
 * sign-in held back. Nothing here talks to WorkOS, and the browser never loads
 * a WorkOS page.
 *
 * ── What is offered ──
 * Google; the email and password (accounts brought from Firebase have one, and
 * the sign-up page sets one); "Forgot password?", which goes to the reset
 * request (`/sign-in/forgot-password`) — the way in for a forgotten password,
 * for an address whose verification was never finished (a reset verifies it),
 * and for an account that has never had a password (a reset sets its first);
 * and an organisation's single sign-on. There is no "email me a code" here any
 * more: "Forgot password?" covers what it was for.
 *
 * While the server's email-verification step is enabled (it is off until
 * WorkOS's ordering is proven — see `server/in-app-sign-in.ts`), a password
 * sign-in to an address WorkOS has not verified asks for the code WorkOS
 * emails to it before anything is signed in; while it is off, that sign-in
 * reads as a wrong password, and "Forgot password?" is the way in.
 *
 * ── Errors ──
 * The routes answer the API's error envelope with the same sentence
 * `/sign-in?error=` shows for the same refusal (`lib/sign-in-errors.ts`), so
 * the page shows `message` and nothing else; a wrong password or code comes
 * back naming its field, and is shown beside it. `initialError` is the
 * sentence for a `?error=` the server page read — a Google or single sign-on
 * attempt that came back refused — shown until the next attempt replaces it.
 */

export interface SignInPanelProps {
  /** Already held to `safeRedirectPath` by the page. */
  next: string;
  /** The sentence for the page's `?error=`, or `null`. */
  initialError?: string | null;
}

type Step = { kind: 'password' } | { kind: 'verify-email'; email: string };

/** What the in-app sign-in routes answer on success. */
interface SignInAnswer {
  redirect?: unknown;
  step?: unknown;
}

export const SIGN_IN_ROUTES = {
  password: '/api/auth/sign-in/password',
  verifyEmail: '/api/auth/sign-in/verify-email',
} as const;

export function SignInPanel({ next, initialError = null }: SignInPanelProps) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const form = useAuthForm(initialError);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local: Record<string, string> = {};
    const emailError = emailProblem(email);
    if (emailError !== null) local['email'] = emailError;
    if (password.length === 0) local['password'] = 'Enter your password.';
    if (!form.begin(local)) return;

    const address = email.trim();
    try {
      const answer = await api.post<SignInAnswer>(
        SIGN_IN_ROUTES.password,
        { email: address, password, next },
        { redirectOnUnauthenticated: false },
      );
      if (answer.step === 'verify-email') {
        // WorkOS's pending token is in an HttpOnly cookie the server set; the
        // page holds only the address it was for.
        setPassword('');
        setCode('');
        form.setBusy(false);
        form.clear();
        setStep({ kind: 'verify-email', email: address });
        return;
      }
      leaveFor(answer.redirect);
    } catch (cause) {
      form.fail(cause, ['email', 'password']);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'verify-email') return;
    const typed = normalisedCode(code);
    const local: Record<string, string> = {};
    if (!/^[0-9]{6}$/.test(typed)) local['code'] = 'Enter the six-digit code from the email.';
    if (!form.begin(local)) return;

    try {
      const answer = await api.post<SignInAnswer>(
        SIGN_IN_ROUTES.verifyEmail,
        { email: step.email, code: typed, next },
        { redirectOnUnauthenticated: false },
      );
      leaveFor(answer.redirect);
    } catch (cause) {
      form.fail(cause, ['code']);
    }
  }

  if (step.kind === 'verify-email') {
    return (
      <div className="flex flex-col gap-5">
        {form.messages}
        <p className="text-fg-muted text-sm leading-6">
          First, confirm your email address. We’ve emailed a six-digit code to{' '}
          <span className="text-fg font-medium break-all">{step.email}</span>.
        </p>

        {/* `noValidate` hands validation to us: the browser's own bubbles
            cannot be styled, are announced inconsistently, and vanish on the
            next keystroke. */}
        <form
          noValidate
          onSubmit={(event) => void submitCode(event)}
          className="flex flex-col gap-4"
        >
          <CodeField
            value={code}
            onChange={setCode}
            error={form.problems['code'] ?? null}
            disabled={form.busy}
          />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={form.busy}>
            Confirm and sign in
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <TextButton
            onClick={() => {
              form.clear();
              setStep({ kind: 'password' });
            }}
            disabled={form.busy}
          >
            Start again
          </TextButton>
        </div>
        <p className="text-fg-subtle text-sm leading-6">
          Didn’t get it? Check your spam folder, or start again and sign in once more to send
          another.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {form.messages}

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

      <form
        noValidate
        onSubmit={(event) => void submitPassword(event)}
        className="flex flex-col gap-4"
      >
        <EmailField
          value={email}
          onChange={setEmail}
          error={form.problems['email'] ?? null}
          disabled={form.busy}
        />

        <Field label="Password" error={form.problems['password'] ?? null}>
          <PasswordInput
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={form.busy}
          />
        </Field>

        <div className="-mt-1 flex justify-end">
          <TextLink href={authScreenHref('/sign-in/forgot-password', next)}>
            Forgot password?
          </TextLink>
        </div>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={form.busy}>
          Sign in
        </Button>
      </form>

      <SingleSignOn next={next} />
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
