import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SIGN_IN_ERROR_MESSAGES } from '@/lib/sign-in-errors';

/**
 * The sign-in and sign-up screens, as a browser first receives them.
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
    expect(text(html)).toContain('Forgot your password? Email me a code');
    expect(text(html)).toContain('Sign in');
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
  it('asks for an email and a code — no password — and offers Google', async () => {
    const html = await signUpPage({ next: '/invite/tok_abc' });

    expect(input(html, 'email')).toContain('autoComplete="email"');
    expect(input(html, 'password')).toBeNull();
    expect(text(html)).toContain('Email me a code');
    expect(hrefs(html)).toContain('/api/auth/login?provider=google&next=%2Finvite%2Ftok_abc');
    expect(hrefs(html)).toContain('/sign-in?next=%2Finvite%2Ftok_abc');
    // Signing up is not where an organisation's single sign-on starts.
    expect(input(html, 'org')).toBeNull();
  });

  it('names no WorkOS and no AuthKit', async () => {
    expect(await signUpPage()).not.toMatch(NO_WORKOS);
  });
});

describe('the code step', () => {
  // The panel's first render is the only one a static render sees; the code
  // step's field is pinned at its source, where its attributes are written.
  const source = readFileSync(
    join(import.meta.dirname, '_components', 'sign-in-panel.tsx'),
    'utf8',
  );

  it('asks for the code as a one-time code, numerically, and never as a password', () => {
    const field = source.slice(source.indexOf('label="Code from the email"'));
    const tag = field.slice(0, field.indexOf('/>'));
    expect(tag).toContain('autoComplete="one-time-code"');
    expect(tag).toContain('inputMode="numeric"');
    expect(tag).not.toContain('type="password"');
  });

  it('posts to the in-app routes and nowhere else, and never logs', () => {
    expect(source).toContain("'/api/auth/sign-in/password'");
    expect(source).toContain("'/api/auth/sign-in/code'");
    expect(source).toContain("'/api/auth/sign-in/code/verify'");
    expect(source).toContain("'/api/auth/sign-in/verify-email'");
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
  });

  it('never adds outline-none', () => {
    expect(source).not.toContain('outline-none');
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
