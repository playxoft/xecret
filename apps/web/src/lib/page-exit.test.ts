import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { beginLeavingPage, isLeavingPage, stayOnPage } from './page-exit';

/**
 * Signing out ends in a navigation to WorkOS's logout URL, which stays pending
 * until the document unloads — and every request the dashboard makes after the
 * revoke answers 401. The API client used to answer each of those with its own
 * navigation to the sign-in page, which replaced the logout before it was sent:
 * AuthKit's session survived, and the next sign-in reused it without asking.
 */

const originalFetch = globalThis.fetch;
const assign = vi.fn();

function respondUnauthenticated(): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: 'unauthenticated', message: 'Sign in again.', requestId: 'r' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  ) as typeof fetch;
}

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('window', {
    location: { pathname: '/app/acme', search: '', hash: '', assign },
  });
});

afterEach(() => {
  stayOnPage();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe('a 401', () => {
  it('sends an ordinary page to sign in, back to where it was', async () => {
    respondUnauthenticated();

    await api.get('/orgs/acme').catch(() => undefined);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/sign-in?next=${encodeURIComponent('/app/acme')}`);
  });

  it('starts no navigation once the page is leaving on purpose', async () => {
    respondUnauthenticated();
    beginLeavingPage();

    const error = await api.get('/auth/me').catch((cause: unknown) => cause);

    // Still refused, so the caller's own handling runs — only the redirect,
    // which would replace the sign-out's navigation, is withheld.
    expect(error).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the leaving flag', () => {
  it('is down until a departure raises it, and down again for a page that comes back', () => {
    expect(isLeavingPage()).toBe(false);
    beginLeavingPage();
    expect(isLeavingPage()).toBe(true);
    // What a page restored from the back-forward cache does.
    stayOnPage();
    expect(isLeavingPage()).toBe(false);
  });
});
