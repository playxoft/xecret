'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, isApiError } from '@/lib/api';
// From their own modules rather than the `components/ui` barrel, as the pages
// do: these forms are all the client code the sign-in screens ship.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { GoogleIcon } from '@/components/ui/icons';
import {
  CodeField,
  EmailField,
  emailProblem,
  leaveFor,
  normalisedCode,
  OrDivider,
  TextButton,
  useAuthForm,
} from './form-parts';
import { loginHref } from './login-href';
import { estimateNewPassword, NewPasswordFields, newPasswordProblem } from './new-password';

/**
 * Creating an account on xecret's own page: an email and a password, then the
 * six-digit code emailed to the address — or Google.
 *
 * ── Two steps, and where the password waits ──
 *  1. Email, password and its confirmation. The password is judged here
 *     (`new-password.tsx`: WorkOS's own bar) and then **kept in this
 *     component's state**: only the address is posted, to
 *     `POST /api/auth/sign-in/code`, which has WorkOS email it a code.
 *  2. The code. Posted with the address and the password to
 *     `POST /api/auth/sign-up`, which checks the code — the proof that the
 *     inbox is the person's — signs them in, and sets the password only on an
 *     account this sign-up created (`app/api/auth/sign-up/route.ts` has why:
 *     a password set before the inbox is proven is a pre-account takeover, and
 *     one set on an existing account would be a reset with none of a reset's
 *     consequences).
 *
 * The answer is the same for an address that has an account and one that does
 * not, until the code is accepted: a code is emailed, a code is checked. After
 * it, the answer may carry a `notice` — the address already had an account
 * (signed in to it, its password unchanged), or the new account's password
 * could not be set — which the page shows before going on. The inbox has been
 * proven by then, so it tells nobody anything the inbox did not.
 *
 * ── Never kept ──
 * The password lives in this component's state until the request that sets
 * it, and nowhere else: never logged, never put in a URL, never stored.
 */

export interface SignUpPanelProps {
  /** Already held to `safeRedirectPath` by the page. */
  next: string;
}

export const SIGN_UP_ROUTES = {
  sendCode: '/api/auth/sign-in/code',
  signUp: '/api/auth/sign-up',
} as const;

type Step =
  | { kind: 'details' }
  | { kind: 'code'; email: string }
  | { kind: 'notice'; notice: SignUpNotice; redirect: unknown };

/** What the sign-up can say once the code is accepted, beside where to go next. */
export type SignUpNotice = 'existing-account' | 'password-too-weak' | 'password-not-set';

const NOTICES: Record<SignUpNotice, { title: string; body: string }> = {
  'existing-account': {
    title: 'You already had an account',
    body: 'We’ve signed you in to it. Its password hasn’t changed — to change it, use “Forgot password?” on the sign-in page.',
  },
  'password-too-weak': {
    title: 'Your account is ready',
    body: 'You’re signed in, but that password was too easy to guess, so it wasn’t set. Choose one any time with “Forgot password?” on the sign-in page.',
  },
  'password-not-set': {
    title: 'Your account is ready',
    body: 'You’re signed in, but your password couldn’t be saved just now. Set one any time with “Forgot password?” on the sign-in page.',
  },
};

function isNotice(value: unknown): value is SignUpNotice {
  return typeof value === 'string' && Object.hasOwn(NOTICES, value);
}

export function SignUpPanel({ next }: SignUpPanelProps) {
  const [step, setStep] = useState<Step>({ kind: 'details' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const form = useAuthForm();

  async function sendCode(address: string, resend: boolean) {
    try {
      await api.post<void>(
        SIGN_UP_ROUTES.sendCode,
        { email: address },
        { redirectOnUnauthenticated: false },
      );
      form.setBusy(false);
      setCode('');
      if (resend) {
        form.setProblems({});
        form.setNotice('We’ve sent a new code. If more than one arrives, use the newest.');
      } else {
        form.clear();
        setStep({ kind: 'code', email: address });
      }
    } catch (cause) {
      form.fail(cause, ['email']);
    }
  }

  async function submitDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.busy) return;
    const local: Record<string, string> = {};
    const emailError = emailProblem(email);
    if (emailError !== null) local['email'] = emailError;
    // Judged before anything is sent: WorkOS can only refuse a password once
    // the code has been spent on it. Busy while the dictionaries load, so a
    // second press waits for this one.
    form.setBusy(true);
    const estimate = password.length > 0 ? await estimateNewPassword(password, email) : null;
    form.setBusy(false);
    const problem = newPasswordProblem({ password, confirm, email, estimate });
    if (problem !== null) local[problem.field] = problem.message;
    if (!form.begin(local)) return;
    await sendCode(email.trim(), false);
  }

  async function resendCode(address: string) {
    if (!form.begin({})) return;
    await sendCode(address, true);
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind !== 'code') return;
    const typed = normalisedCode(code);
    const local: Record<string, string> = {};
    if (!/^[0-9]{6}$/.test(typed)) local['code'] = 'Enter the six-digit code from the email.';
    if (!form.begin(local)) return;

    try {
      const answer = await api.post<{ redirect?: unknown; notice?: unknown }>(
        SIGN_UP_ROUTES.signUp,
        { email: step.email, code: typed, password, next },
        { redirectOnUnauthenticated: false },
      );
      // Signed in either way; the password is no longer needed here.
      setPassword('');
      setConfirm('');
      if (isNotice(answer.notice)) {
        form.setBusy(false);
        form.clear();
        setStep({ kind: 'notice', notice: answer.notice, redirect: answer.redirect });
        return;
      }
      leaveFor(answer.redirect);
    } catch (cause) {
      // A password the server refused on shape belongs to the first step:
      // back to it, the sentence beside the field. (Refused before WorkOS was
      // asked anything, so the code is still good.)
      if (isApiError(cause) && 'password' in cause.fieldErrors()) {
        form.fail(cause, ['password']);
        setCode('');
        setStep({ kind: 'details' });
        return;
      }
      form.fail(cause, ['code']);
    }
  }

  if (step.kind === 'notice') {
    const { title, body } = NOTICES[step.notice];
    return (
      <div className="flex flex-col gap-5">
        <Alert tone={step.notice === 'existing-account' ? 'info' : 'warning'} title={title}>
          {body}
        </Alert>
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          onClick={() => leaveFor(step.redirect)}
        >
          Continue
        </Button>
      </div>
    );
  }

  if (step.kind === 'code') {
    return (
      <div className="flex flex-col gap-5">
        {form.messages}
        <p className="text-fg-muted text-sm leading-6">
          We’ve emailed a six-digit code to{' '}
          <span className="text-fg font-medium break-all">{step.email}</span>. Enter it to finish
          creating your account. It expires in ten minutes.
        </p>

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
            Create account
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <TextButton onClick={() => void resendCode(step.email)} disabled={form.busy}>
            Send a new code
          </TextButton>
          <TextButton
            onClick={() => {
              form.clear();
              setCode('');
              setStep({ kind: 'details' });
            }}
            disabled={form.busy}
          >
            Change email or password
          </TextButton>
        </div>
        <p className="text-fg-subtle text-sm leading-6">
          Already have an account at this address? The code signs you in to it, and its password
          stays as it is.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {form.messages}

      <Button variant="secondary" size="lg" className="w-full" asChild>
        {/* A plain link, as on the sign-in page: the login route answers with
            a redirect to Google by way of WorkOS. */}
        <a href={loginHref({ next, provider: 'google' })}>
          <GoogleIcon className="size-4" />
          Continue with Google
        </a>
      </Button>

      <OrDivider />

      <form
        noValidate
        onSubmit={(event) => void submitDetails(event)}
        className="flex flex-col gap-4"
      >
        <EmailField
          value={email}
          onChange={setEmail}
          error={form.problems['email'] ?? null}
          disabled={form.busy}
        />
        <NewPasswordFields
          password={password}
          onPassword={setPassword}
          confirm={confirm}
          onConfirm={setConfirm}
          problems={form.problems}
          disabled={form.busy}
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={form.busy}>
          Create account
        </Button>
      </form>
    </div>
  );
}
