'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { api, isApiError } from '@/lib/api';
// From their own modules rather than the `components/ui` barrel, as the pages
// do: these forms are all the client code the sign-in screens ship.
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmailField, emailProblem, TextButton, TextLink, useAuthForm } from './form-parts';
import { authScreenHref } from './login-href';
import { estimateNewPassword, NewPasswordFields, newPasswordProblem } from './new-password';

/**
 * "Forgot password?", on xecret's own pages: asking for a reset link, and
 * choosing the new password from it (`server/password-reset.ts` has the
 * server half).
 *
 *  - {@link ForgotPasswordPanel} posts the address to
 *    `POST /api/auth/password-reset` and then says the one sentence true of
 *    every address — if it has an account, a link is on its way. The server
 *    answers every address alike, and so does the page.
 *  - {@link ResetPasswordPanel} is where the emailed link lands
 *    (`/sign-in/reset-password?token=…`, the WorkOS environment's password
 *    reset URL). It takes the token out of the address bar as soon as it runs,
 *    asks for the new password twice, and posts it with the token to
 *    `POST /api/auth/password-reset/confirm`. Done, it sends the person to sign
 *    in with it — never signs them in itself: a reset link signing its user in
 *    would let somebody send a victim the link to *their own* account.
 */

export const PASSWORD_RESET_ROUTES = {
  request: '/api/auth/password-reset',
  confirm: '/api/auth/password-reset/confirm',
} as const;

export function ForgotPasswordPanel({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useAuthForm();

  async function send(address: string) {
    try {
      await api.post<void>(
        PASSWORD_RESET_ROUTES.request,
        { email: address },
        { redirectOnUnauthenticated: false },
      );
      form.setBusy(false);
      setSentTo(address);
    } catch (cause) {
      form.fail(cause, ['email']);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local: Record<string, string> = {};
    const emailError = emailProblem(email);
    if (emailError !== null) local['email'] = emailError;
    if (!form.begin(local)) return;
    await send(email.trim());
  }

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-5">
        {form.messages}
        <p className="text-fg-muted text-sm leading-6">
          If <span className="text-fg font-medium break-all">{sentTo}</span> has a xecret account,
          we’ve emailed it a link to choose a new password. The link works for fifteen minutes.
        </p>
        <p className="text-fg-subtle text-sm leading-6">
          Nothing after a few minutes? Check your spam folder, or check the address and try again.
          If you signed up with Google, you can also keep using Google.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <TextButton
            onClick={() => {
              form.clear();
              setSentTo(null);
            }}
            disabled={form.busy}
          >
            Use a different email
          </TextButton>
          <TextLink href={authScreenHref('/sign-in', next)}>Back to sign in</TextLink>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {form.messages}
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <EmailField
          value={email}
          onChange={setEmail}
          error={form.problems['email'] ?? null}
          disabled={form.busy}
          autoFocus
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={form.busy}>
          Email me a reset link
        </Button>
      </form>
      <div className="flex justify-center">
        <TextLink href={authScreenHref('/sign-in', next)}>Back to sign in</TextLink>
      </div>
    </div>
  );
}

export interface ResetPasswordPanelProps {
  /**
   * The link's token, read by the server page and held to shape there — or
   * `null` for a link without a usable one.
   */
  token: string | null;
}

export function ResetPasswordPanel({ token }: ResetPasswordPanelProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [linkRefused, setLinkRefused] = useState(token === null);
  const form = useAuthForm(
    token === null
      ? 'That reset link is incomplete. Open it from the email again, or ask for a new one.'
      : null,
  );

  // The token is as good as the password it is about to set, for fifteen
  // minutes: out of the address bar, the history entry and anything copied
  // from either, as soon as the page runs. (The page sends no referrer either.)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('token')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === null || form.busy) return;
    form.setBusy(true);
    const estimate = password.length > 0 ? await estimateNewPassword(password, '') : null;
    form.setBusy(false);
    const problem = newPasswordProblem({ password, confirm, email: '', estimate });
    if (!form.begin(problem === null ? {} : { [problem.field]: problem.message })) return;

    try {
      await api.post<void>(
        PASSWORD_RESET_ROUTES.confirm,
        { token, password },
        { redirectOnUnauthenticated: false },
      );
      form.setBusy(false);
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (cause) {
      form.fail(cause, ['password']);
      // Anything about the link rather than the password: this link is done.
      if (isLinkRefusal(cause)) setLinkRefused(true);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <Alert tone="success">Your password has been changed.</Alert>
        <p className="text-fg-muted text-sm leading-6">
          Sign in with your email address and the new password. Anywhere you were already signed in
          has been signed out.
        </p>
        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href="/sign-in">Sign in</a>
        </Button>
      </div>
    );
  }

  if (linkRefused) {
    return (
      <div className="flex flex-col gap-5">
        {form.messages}
        <Button variant="primary" size="lg" className="w-full" asChild>
          <a href="/sign-in/forgot-password">Ask for a new link</a>
        </Button>
        <div className="flex justify-center">
          <TextLink href="/sign-in">Back to sign in</TextLink>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {form.messages}
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <NewPasswordFields
          label="New password"
          password={password}
          onPassword={setPassword}
          confirm={confirm}
          onConfirm={setConfirm}
          problems={form.problems}
          disabled={form.busy}
        />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={form.busy}>
          Change password
        </Button>
      </form>
    </div>
  );
}

/**
 * A refusal of the link itself — a 400 or a 422 (a token of the wrong shape)
 * that names no field the form shows — as opposed to the password, the
 * service, or a rate limit, after which the same link may still work.
 */
function isLinkRefusal(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    (cause.status === 400 || cause.status === 422) &&
    !('password' in cause.fieldErrors())
  );
}
