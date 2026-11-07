import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLockCatchUp } from '@/app/(dashboard)/_lib/lock-catch-up';
import {
  holdVaultKeys,
  releaseVaultKeys,
  setMirrorStorage,
  subscribeVaultKeys,
  vaultKeysHeld,
} from '@/components/vault/key-store';
import { VAULT_SESSION_MIRROR_KEY } from '@/components/vault/session-mirror';
import type { MirrorStorage } from '@/components/vault/session-mirror';
import { api } from './api';
import {
  beginLeavingPage,
  beginSignInRedirect,
  isLeavingOnPurpose,
  isLeavingPage,
  stayOnPage,
} from './page-exit';

/**
 * What a 401 does on the way to the sign-in page, and what it must not do.
 *
 * It releases the vault keys. A session that ends without a lock — expired,
 * revoked, signed out from another device — used to reach the sign-in page with
 * the User Key and both private keys still in memory and in the tab's
 * `sessionStorage` mirror, for whoever signed in next in it.
 *
 * And it starts one navigation, never two. Signing out heads for WorkOS's logout
 * URL, which stays pending until the document unloads, and every request after
 * the revoke answers 401; a redirect from any of them replaced the logout before
 * it was sent, and AuthKit's session survived.
 */

const originalFetch = globalThis.fetch;
const assign = vi.fn();

function material(fill = 7) {
  return {
    userId: 'user-1',
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

/** The tab's `sessionStorage`, inspectable. */
function fakeStorage(): MirrorStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

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

function onPage(pathname: string): void {
  vi.stubGlobal('window', { location: { pathname, search: '', hash: '', assign } });
}

/** Counts how many times the vault keys were released — notified as not held. */
function countReleases(): { count: () => number; stop: () => void } {
  let releases = 0;
  const stop = subscribeVaultKeys(() => {
    if (!vaultKeysHeld()) releases += 1;
  });
  return { count: () => releases, stop };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  assign.mockReset();
  storage = fakeStorage();
  setMirrorStorage(storage);
  onPage('/app/acme');
});

afterEach(() => {
  stayOnPage();
  releaseVaultKeys();
  setMirrorStorage(null);
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe('a 401', () => {
  it('sends the page to sign in, back to where it was', async () => {
    respondUnauthenticated();

    await api.get('/orgs/acme').catch(() => undefined);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/sign-in?next=${encodeURIComponent('/app/acme')}`);
  });

  it('releases the vault keys first, and empties the mirror with them', async () => {
    holdVaultKeys(material());
    expect(storage.entries.has(VAULT_SESSION_MIRROR_KEY)).toBe(true);
    const releases = countReleases();
    respondUnauthenticated();

    await api.get('/orgs/acme').catch(() => undefined);
    releases.stop();

    expect(vaultKeysHeld()).toBe(false);
    expect(releases.count()).toBe(1);
    expect(storage.entries.has(VAULT_SESSION_MIRROR_KEY)).toBe(false);
  });

  it('empties a mirror even when nothing was held — a reloaded tab not yet restored', async () => {
    holdVaultKeys(material());
    // What a reload leaves behind: the mirror on disk, nothing in memory.
    const mirrored = storage.entries.get(VAULT_SESSION_MIRROR_KEY) ?? '';
    releaseVaultKeys();
    storage.entries.set(VAULT_SESSION_MIRROR_KEY, mirrored);
    respondUnauthenticated();

    await api.get('/orgs/acme').catch(() => undefined);

    expect(storage.entries.has(VAULT_SESSION_MIRROR_KEY)).toBe(false);
  });

  it('releases once and navigates once for a burst of them', async () => {
    holdVaultKeys(material());
    const releases = countReleases();
    respondUnauthenticated();

    await Promise.all([
      api.get('/orgs/acme').catch(() => undefined),
      api.get('/orgs/acme/projects').catch(() => undefined),
      api.get('/auth/me').catch(() => undefined),
    ]);
    releases.stop();

    expect(releases.count()).toBe(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('does not loop through the shell: the re-read its release would start is never sent', async () => {
    // The release reaches the shell's catch-up, whose re-read of the session
    // would be one more 401 — and one more redirect — if it went out.
    holdVaultKeys(material());
    const reload = vi.fn(async () => {});
    const disarm = createLockCatchUp({ reload, lockVault: async () => 1 }).arm({
      awaitKeys: true,
    });
    respondUnauthenticated();

    await api.get('/orgs/acme').catch(() => undefined);
    await flush();
    disarm();

    expect(reload).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('releases nothing and goes nowhere for a call that opts out of the redirect', async () => {
    holdVaultKeys(material());
    const releases = countReleases();
    respondUnauthenticated();

    await api
      .get('/auth/me', { redirectOnUnauthenticated: false })
      .catch((cause: unknown) => cause);
    releases.stop();

    expect(releases.count()).toBe(0);
    expect(vaultKeysHeld()).toBe(true);
    expect(storage.entries.has(VAULT_SESSION_MIRROR_KEY)).toBe(true);
    expect(assign).not.toHaveBeenCalled();
    expect(isLeavingPage()).toBe(false);
  });

  it('releases nothing and goes nowhere on the sign-in page itself', async () => {
    onPage('/sign-in');
    holdVaultKeys(material());
    respondUnauthenticated();

    await api.get('/auth/me').catch(() => undefined);

    expect(vaultKeysHeld()).toBe(true);
    expect(assign).not.toHaveBeenCalled();
    expect(isLeavingPage()).toBe(false);
  });

  it('starts no navigation once a sign-out is under way, and leaves its keys to it', async () => {
    holdVaultKeys(material());
    respondUnauthenticated();
    beginLeavingPage();

    const error = await api.get('/auth/me').catch((cause: unknown) => cause);

    // Still refused, so the caller's own handling runs — only the redirect,
    // which would replace the sign-out's navigation, is withheld. The sign-out
    // releases the keys itself.
    expect(error).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('the departure flag', () => {
  it('is down until a departure raises it, and down again for a page that comes back', () => {
    expect(isLeavingPage()).toBe(false);
    beginLeavingPage();
    expect(isLeavingPage()).toBe(true);
    // What a page restored from the back-forward cache does.
    stayOnPage();
    expect(isLeavingPage()).toBe(false);
  });

  it('tells a sign-out from a redirect to sign in, and a redirect never downgrades a sign-out', () => {
    beginSignInRedirect();
    expect(isLeavingPage()).toBe(true);
    // A redirect nobody chose still lets the browser ask about staged work.
    expect(isLeavingOnPurpose()).toBe(false);

    beginLeavingPage();
    expect(isLeavingOnPurpose()).toBe(true);
    beginSignInRedirect();
    expect(isLeavingOnPurpose()).toBe(true);
  });
});
