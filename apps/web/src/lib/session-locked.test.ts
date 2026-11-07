import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, isApiError } from './api';
import { announceSessionLocked, subscribeSessionLocked } from './session-locked';

/**
 * A request refused because the vault is locked, reaching the shell.
 *
 * The dashboard learns it is locked only by re-reading `/api/auth/me`, and it
 * used to do that only after a lock it performed itself. A lock it did not
 * perform — the server's idle window closing first — reached every screen as
 * "Could not load this project". The signal is what lets the shell catch up, so
 * what is pinned here is that every such refusal raises it, nothing else does,
 * and the caller still receives the refusal it always did.
 */

const originalFetch = globalThis.fetch;

function respond(body: unknown, status: number): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-xecret-request-id': 'req-1' },
      }),
  ) as typeof fetch;
}

/** Lets queued microtasks — the signal's delivery — run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const unsubscribers: (() => void)[] = [];

function listen() {
  const listener = vi.fn();
  unsubscribers.push(subscribeSessionLocked(listener));
  return listener;
}

beforeEach(() => {
  // No DOM: a 401 below must not try to navigate.
  vi.stubGlobal('window', undefined);
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session-locked signal', () => {
  it('reaches every listener, after the announcement rather than inside it', async () => {
    const first = listen();
    const second = listen();

    announceSessionLocked();
    // Not yet: delivery is queued, so a listener can never stand in for the
    // throw that follows the announcement in the API client.
    expect(first).not.toHaveBeenCalled();

    await settle();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops reaching a listener once it unsubscribes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionLocked(listener);
    unsubscribe();

    announceSessionLocked();
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('skips a listener removed between the announcement and its delivery', async () => {
    // The shell unsubscribes the moment it is drawing the lock screen, and a
    // notice already queued must not start a re-read underneath it.
    const listener = vi.fn();
    const unsubscribe = subscribeSessionLocked(listener);

    announceSessionLocked();
    unsubscribe();
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('a request refused as session_locked', () => {
  const LOCKED = {
    error: { code: 'session_locked', message: 'Unlock your vault to continue.', requestId: 'r' },
  };

  it('raises the signal, and still rejects with the refusal', async () => {
    const listener = listen();
    respond(LOCKED, 403);

    const error = await api.get('/orgs/acme/projects/api').catch((cause: unknown) => cause);

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.code).toBe('session_locked');
    expect(error.status).toBe(403);

    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('raises it for a mutation too — the lock request itself included', async () => {
    // The idle timer's own `POST /api/auth/vault/lock` is refused this way when
    // the server's window closed first; that refusal is what used to strand the
    // dashboard without keys.
    const listener = listen();
    respond(LOCKED, 403);

    await api.post('/auth/vault/lock', { everywhere: false }).catch(() => undefined);

    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['forbidden', 403],
    ['sso_required', 403],
    ['plan_limit', 403],
    ['unauthenticated', 401],
    ['internal_error', 500],
  ])('does not raise it for %s', async (code, status) => {
    const listener = listen();
    respond({ error: { code, message: 'A sentence.', requestId: 'r' } }, status);

    await api.get('/orgs/acme').catch(() => undefined);

    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not raise it for a request that succeeded', async () => {
    const listener = listen();
    respond({ ok: true }, 200);

    await api.get('/auth/me');

    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
