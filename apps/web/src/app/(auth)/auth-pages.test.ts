import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SIGN_IN_ERROR_MESSAGES } from '@/lib/sign-in-errors';

/**
 * The sign-in, sign-up and password-reset screens, as a browser first
 * receives them.
 *
 * Rendered to static markup — the server pages themselves, with the panel the
 * form lives in — because what is worth pinning is what a person is handed
 * before any script runs: which fields there are and what a password manager
 * and a phone keyboard are told about them, where "Continue with Google" and
 * "Sign in with single sign-on" lead, that `next` survives into every way out,
 * and that no WorkOS name or AuthKit page appears anywhere a person can see.
 * The routes behind the form are `server/in-app-sign-in-route.test.ts`'s.
 */

// The SSO warning page mints its "Continue" token from a cookie and the
// deployment's key; neither exists here, and neither is under test.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/server/context', () => ({ workerContext: vi.fn() }));
vi.mock('@/server/sign-in', () => ({ ssoContinueKey: vi.fn() }));

const { default: SignInPage } = await import('./sign-in/page');
const { default: SignUpPage } = await import('./sign-up/page');
const { default: ForgotPasswordPage } = await import('./sign-in/forgot-password/page');
const resetPasswordModule = await import('./sign-in/reset-password/page');
const ResetPasswordPage = resetPasswordModule.default;

type Search = Record<string, string | string[] | undefined>;

async function signInPage(search: Search = {}): Promise<string> {
  const element = await SignInPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as unknown as Parameters<typeof SignInPage>[0]);
  return renderToStaticMarkup(element as ReactElement);
}

async function signUpPage(search: Search = {}): Promise<string> {
  const element = await SignUpPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as unknown as Parameters<typeof SignUpPage>[0]);
  return renderToStaticMarkup(element as ReactElement);
}

async function forgotPasswordPage(search: Search = {}): Promise<string> {
  const element = await ForgotPasswordPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as unknown as Parameters<typeof ForgotPasswordPage>[0]);
  return renderToStaticMarkup(element as ReactElement);
}

async function resetPasswordPage(search: Search = {}): Promise<string> {
  const element = await ResetPasswordPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as unknown as Parameters<typeof ResetPasswordPage>[0]);
  return renderToStaticMarkup(element as ReactElement);
}

/** The `<input …>` tag whose `name` is `name`, or `null`. */
function input(html: string, name: string): string | null {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? null;
}

/** Every `href` on the page, decoded as the browser will. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
}

/** The visible text, tags removed, entities for quotes left in. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

const NO_WORKOS = /workos|authkit/i;

describe('the sign-in page', () => {
  it('offers email and password on the page, with the autocomplete a password manager needs', async () => {
    const html = await signInPage();

    const email = input(html, 'email');
    const password = input(html, 'password');
    expect(email).toContain('type="email"');
    expect(email).toContain('autoComplete="username"');
    expect(password).toContain('type="password"');
    expect(password).toContain('autoComplete="current-password"');
    expect(text(html)).toContain('Sign in');
  });

  it('offers “Forgot password?” as a link to the reset request — and no emailed-code sign-in', async () => {
    const html = await signInPage();

    expect(hrefs(html)).toContain('/sign-in/forgot-password');
    expect(text(html)).toContain('Forgot password?');
    expect(text(html)).not.toMatch(/email me a code|code instead|sign-in code/i);
    expect(input(html, 'code')).toBeNull();
    expect(html).not.toContain('/api/auth/sign-in/code');
  });

  it('goes to Google through the login route, never to a WorkOS page', async () => {
    const html = await signInPage();

    expect(hrefs(html)).toContain('/api/auth/login?provider=google');
    expect(text(html)).toContain('Continue with Google');
  });

  it('offers single sign-on as a GET form to the login route, which sends it to this page’s warning', async () => {
    const html = await signInPage();

    const form = html.match(/<form[^>]*action="\/api\/auth\/login"[^>]*>/)?.[0] ?? '';
    expect(form).toContain('method="get"');
    expect(input(html, 'org')).not.toBeNull();
    expect(text(html)).toContain('Sign in with single sign-on');
    // No `next` to carry for the default destination.
    expect(input(html, 'next')).toBeNull();
  });

  it('carries an invitation’s next into Google and single sign-on alike', async () => {
    const html = await signInPage({ next: '/invite/tok_abc' });

    expect(hrefs(html)).toContain('/api/auth/login?provider=google&next=%2Finvite%2Ftok_abc');
    expect(input(html, 'next')).toContain('value="/invite/tok_abc"');
    expect(hrefs(html)).toContain('/sign-up?next=%2Finvite%2Ftok_abc');
    expect(hrefs(html)).toContain('/sign-in/forgot-password?next=%2Finvite%2Ftok_abc');
  });

  it('drops a next that is not a same-origin path, everywhere it would have gone', async () => {
    const html = await signInPage({ next: 'https://evil.example/' });

    expect(html).not.toContain('evil.example');
    expect(hrefs(html)).toContain('/api/auth/login?provider=google');
  });

  it.each(['account-conflict', 'sso-not-found', 'authenticator-required', 'declined'] as const)(
    'shows the sentence for ?error=%s, and nothing for a code it does not know',
    async (code) => {
      const html = await signInPage({ error: code });
      expect(html).toContain('role="alert"');
      expect(text(html)).toContain(SIGN_IN_ERROR_MESSAGES[code]);

      const unknown = await signInPage({ error: '<script>alert(1)</script>' });
      expect(unknown).not.toContain('alert(1)');
      expect(unknown).not.toContain('role="alert"');
    },
  );

  it('keeps the organisation warning for an SSO deep link, with no form on it', async () => {
    const html = await signInPage({ org: 'acme-corp' });

    expect(text(html)).toContain('Check that this is your organisation');
    expect(hrefs(html)).toContain('/api/auth/login?org=acme-corp');
    expect(input(html, 'password')).toBeNull();
  });

  it('names no WorkOS and no AuthKit anywhere a person can see — in any state', async () => {
    for (const html of [
      await signInPage(),
      await signInPage({ error: 'unavailable', next: '/app/acme' }),
      await signInPage({ org: 'acme-corp' }),
    ]) {
      expect(html).not.toMatch(NO_WORKOS);
    }
  });
});

describe('the sign-up page', () => {
  it('asks for an email and a new password twice — new-password for a password manager — and offers Google', async () => {
    const html = await signUpPage({ next: '/invite/tok_abc' });

    expect(input(html, 'email')).toContain('autoComplete="username"');
    expect(input(html, 'password')).toContain('type="password"');
    expect(input(html, 'password')).toContain('autoComplete="new-password"');
    expect(input(html, 'confirm')).toContain('autoComplete="new-password"');
    expect(text(html)).toContain('Create account');
    expect(text(html)).not.toMatch(/email me a code/i);
    expect(hrefs(html)).toContain('/api/auth/login?provider=google&next=%2Finvite%2Ftok_abc');
    expect(hrefs(html)).toContain('/sign-in?next=%2Finvite%2Ftok_abc');
    // Signing up is not where an organisation's single sign-on starts.
    expect(input(html, 'org')).toBeNull();
  });

  it('names no WorkOS and no AuthKit', async () => {
    expect(await signUpPage()).not.toMatch(NO_WORKOS);
  });
});

describe('the password-reset screens', () => {
  it('asks for the address on the request page, and leads back to sign-in keeping next', async () => {
    const html = await forgotPasswordPage({ next: '/invite/tok_abc' });

    expect(input(html, 'email')).toContain('type="email"');
    expect(input(html, 'email')).toContain('autoComplete="username"');
    expect(input(html, 'password')).toBeNull();
    expect(text(html)).toContain('Email me a reset link');
    expect(hrefs(html)).toContain('/sign-in?next=%2Finvite%2Ftok_abc');
  });

  it('asks for the new password twice on the link’s page, both new-password', async () => {
    const html = await resetPasswordPage({ token: 'tok-reset-aaaa-bbbb' });

    expect(input(html, 'password')).toContain('autoComplete="new-password"');
    expect(input(html, 'confirm')).toContain('autoComplete="new-password"');
    expect(input(html, 'email')).toBeNull();
    expect(text(html)).toContain('Change password');
    // The token is the form's to post, not the page's to show.
    expect(text(html)).not.toContain('tok-reset-aaaa-bbbb');
  });

  it.each([
    [{}],
    [{ token: '' }],
    [{ token: 'has a space' }],
    [{ token: ['a', 'b'] }],
    [{ token: 'x'.repeat(300) }],
  ])(
    'says a link without a usable token is incomplete, and offers a new one: %j',
    async (search) => {
      const html = await resetPasswordPage(search);

      expect(input(html, 'password')).toBeNull();
      expect(text(html)).toContain('That reset link is incomplete');
      expect(hrefs(html)).toContain('/sign-in/forgot-password');
    },
  );

  it('sends no referrer and asks not to be indexed: its URL carries the token', () => {
    expect(resetPasswordModule.metadata.referrer).toBe('no-referrer');
    expect(resetPasswordModule.metadata.robots).toEqual({ index: false, follow: false });
  });

  it('names no WorkOS and no AuthKit', async () => {
    for (const html of [
      await forgotPasswordPage(),
      await resetPasswordPage({ token: 'tok-reset-aaaa-bbbb' }),
      await resetPasswordPage(),
    ]) {
      expect(html).not.toMatch(NO_WORKOS);
    }
  });
});

describe('the forms, at their source', () => {
  // A panel's first render is the only one a static render sees; the later
  // steps' fields are pinned at their source, where their attributes are
  // written.
  const read = (file: string) =>
    readFileSync(join(import.meta.dirname, '_components', file), 'utf8');
  const parts = read('form-parts.tsx');
  const signIn = read('sign-in-panel.tsx');
  const signUp = read('sign-up-panel.tsx');
  const reset = read('password-reset-panel.tsx');
  const newPassword = read('new-password.tsx');
  const all = [parts, signIn, signUp, reset, newPassword].join('\n');

  it('asks for the code as a one-time code, numerically, and never as a password', () => {
    const field = parts.slice(parts.indexOf('label="Code from the email"'));
    const tag = field.slice(0, field.indexOf('/>'));
    expect(tag).toContain('autoComplete="one-time-code"');
    expect(tag).toContain('inputMode="numeric"');
    expect(tag).not.toContain('type="password"');
  });

  it('posts to the in-app routes and nowhere else — and nothing posts an emailed code to sign in', () => {
    expect(signIn).toContain("'/api/auth/sign-in/password'");
    expect(signIn).toContain("'/api/auth/sign-in/verify-email'");
    expect(signIn).not.toContain('/api/auth/sign-in/code');
    expect(signUp).toContain("'/api/auth/sign-in/code'");
    expect(signUp).toContain("'/api/auth/sign-up'");
    expect(reset).toContain("'/api/auth/password-reset'");
    expect(reset).toContain("'/api/auth/password-reset/confirm'");
    expect(all).not.toContain('/api/auth/sign-in/code/verify');
  });

  it('never logs, and never keeps anything in storage', () => {
    expect(all).not.toMatch(/console\./);
    expect(all).not.toMatch(/localStorage|sessionStorage/);
  });

  it('drops the reset token from the address bar as soon as the page runs', () => {
    expect(reset).toContain("window.history.replaceState(null, '', window.location.pathname)");
  });

  it('never adds outline-none', () => {
    expect(all).not.toContain('outline-none');
  });
});

describe('the invitation screen', () => {
  // `invite-screen.tsx` is a client screen that fetches before it renders; its
  // links to the two sign-in screens are pinned at the source, and the pages
  // above are what they land on.
  const source = readFileSync(
    join(import.meta.dirname, 'invite', '[token]', 'invite-screen.tsx'),
    'utf8',
  );

  it('sends a signed-out invitee to sign in or sign up with the invitation as next', () => {
    expect(source).toContain('href={`/sign-in?next=${encodeURIComponent(nextPath)}`}');
    expect(source).toContain('href={`/sign-up?next=${encodeURIComponent(nextPath)}`}');
    expect(source).toContain('const nextPath = `/invite/${encodeURIComponent(token)}`;');
  });

  it('lands back on the invitation: its next is a path the in-app routes keep', async () => {
    const { safePostSignInPath } = await import('@/lib/redirect-path');
    const nextPath = `/invite/${encodeURIComponent('tok_ABC-123')}`;
    // The page reads `next` back out of its own query, as Next decodes it.
    const received = new URL(
      `/sign-in?next=${encodeURIComponent(nextPath)}`,
      'https://x.test',
    ).searchParams.get('next');
    expect(safePostSignInPath(received, '/app')).toBe(nextPath);
  });
});
