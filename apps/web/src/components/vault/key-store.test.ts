import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  holdVaultKeys,
  readVaultKeys,
  releaseVaultKeys,
  restoreVaultKeys,
  setMirrorStorage,
  shouldReleaseForServerVerdict,
  subscribeVaultKeys,
  vaultKeysHeld,
} from './key-store';
import { VAULT_SESSION_MIRROR_KEY } from './session-mirror';
import type { MirrorStorage } from './session-mirror';

/**
 * The lock's actual semantics.
 *
 * Every assertion here is about a claim the product makes out loud: that locking
 * removes the key material from this browser, that it does so even when the
 * request behind it failed, and that a second unlock cannot leave the first
 * one's key resident. A regression in any of them is invisible on screen — the
 * lock screen appears either way — which is exactly why they are tested rather
 * than reviewed.
 */

function material(fill: number, userId = 'user-1') {
  return {
    userId,
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

/** A `sessionStorage` that can be inspected. These tests run without a DOM. */
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

afterEach(() => {
  releaseVaultKeys();
  setMirrorStorage(null);
});

describe('holding keys', () => {
  it('reports locked until keys are held', () => {
    expect(vaultKeysHeld()).toBe(false);
    expect(readVaultKeys()).toBeNull();

    holdVaultKeys(material(1));

    expect(vaultKeysHeld()).toBe(true);
    expect(readVaultKeys()?.userId).toBe('user-1');
  });

  it('hands back the same object, so a subscriber can compare by identity', () => {
    const keys = material(1);
    holdVaultKeys(keys);
    expect(readVaultKeys()).toBe(keys);
  });
});

describe('releasing keys', () => {
  it('overwrites every secret byte it was holding', () => {
    const keys = material(7);
    holdVaultKeys(keys);

    releaseVaultKeys();

    // The caller's arrays, not copies: `holdVaultKeys` takes ownership, and
    // wiping a copy while the original stayed on the heap would be the failure
    // this whole design exists to prevent.
    expect([...keys.userKey]).toEqual(Array<number>(32).fill(0));
    expect([...keys.encPrivateKey]).toEqual(Array<number>(32).fill(0));
    expect([...keys.signPrivateKey]).toEqual(Array<number>(32).fill(0));
  });

  it('leaves the public keys alone, because they are not secret', () => {
    const keys = material(7);
    holdVaultKeys(keys);

    releaseVaultKeys();

    expect(keys.encPublicKey.some((byte) => byte !== 0)).toBe(true);
    expect(keys.signPublicKey.some((byte) => byte !== 0)).toBe(true);
  });

  it('reports locked afterwards', () => {
    holdVaultKeys(material(3));
    releaseVaultKeys();

    expect(vaultKeysHeld()).toBe(false);
    expect(readVaultKeys()).toBeNull();
  });

  it('is safe to call when already locked', () => {
    // Called from the idle timer, from sign-out, from the Lock button and from
    // the 401 path. One that threw would make three of those four write a guard.
    expect(() => {
      releaseVaultKeys();
      releaseVaultKeys();
    }).not.toThrow();
  });
});

describe('replacing keys', () => {
  it('zeroizes the superseded set', () => {
    // A passphrase change, a recovery, or a second tab racing the first: an
    // unlock arriving while another is resident must not leave the old copy.
    const first = material(5);
    holdVaultKeys(first);
    holdVaultKeys(material(9));

    expect([...first.userKey]).toEqual(Array<number>(32).fill(0));
    expect(readVaultKeys()?.userKey[0]).toBe(9);
  });
});

describe('the session mirror', () => {
  it('survives a reload: the same bytes come back, in new arrays', () => {
    const storage = fakeStorage();
    setMirrorStorage(storage);

    const keys = material(11);
    holdVaultKeys(keys);
    const blob = storage.entries.get(VAULT_SESSION_MIRROR_KEY) as string;
    expect(blob).toBeTypeOf('string');

    // What a reload really is, from this module's point of view: the singleton
    // is gone and the storage is not. (The lock below clears the mirror, which
    // closing a tab does not, so the blob is put back.)
    releaseVaultKeys();
    storage.entries.set(VAULT_SESSION_MIRROR_KEY, blob);

    expect(restoreVaultKeys('user-1')).toBe(true);
    expect(readVaultKeys()?.userKey[0]).toBe(11);
    // Not the caller's arrays, which the lock above already overwrote.
    expect(readVaultKeys()?.userKey).not.toBe(keys.userKey);
  });

  it('restores nothing when there is nothing mirrored', () => {
    setMirrorStorage(fakeStorage());

    expect(restoreVaultKeys('user-1')).toBe(false);
    expect(vaultKeysHeld()).toBe(false);
  });

  it('refuses a mirror belonging to another account', () => {
    // An expired session is a redirect to sign-in with no lock in between, so
    // the blob outlives its own account inside one tab.
    const storage = fakeStorage();
    setMirrorStorage(storage);
    holdVaultKeys(material(11));
    const blob = storage.entries.get(VAULT_SESSION_MIRROR_KEY) as string;

    releaseVaultKeys();
    storage.entries.set(VAULT_SESSION_MIRROR_KEY, blob);

    expect(restoreVaultKeys('somebody-else')).toBe(false);
    expect(vaultKeysHeld()).toBe(false);
  });

  it('releases keys held for a different account rather than answering yes', () => {
    // The store is a module singleton and the account is not. Signing out and
    // back in as somebody else never unmounts the page, so the previous
    // account's User Key can still be resident when this provider mounts for
    // the next one — and "something is held" is not "your keys are held".
    const storage = fakeStorage();
    setMirrorStorage(storage);
    const previous = material(11, 'user-1');
    holdVaultKeys(previous);

    expect(restoreVaultKeys('user-2')).toBe(false);
    expect(vaultKeysHeld()).toBe(false);
    // Released, not merely forgotten: the bytes are gone and so is the mirror
    // that would otherwise hand them to the next reload.
    expect(previous.userKey.every((byte) => byte === 0)).toBe(true);
    expect(storage.entries.size).toBe(0);
  });

  it('leaves a tab that already holds keys alone', () => {
    // A tab that is unlocked has newer material than anything in storage — an
    // unlock that landed between the reload and this call, say.
    const storage = fakeStorage();
    setMirrorStorage(storage);
    holdVaultKeys(material(11));
    const current = readVaultKeys();

    expect(restoreVaultKeys('user-1')).toBe(true);
    expect(readVaultKeys()).toBe(current);
  });

  it('is cleared by a lock, so the next reload lands on the lock screen', () => {
    const storage = fakeStorage();
    setMirrorStorage(storage);
    holdVaultKeys(material(11));

    releaseVaultKeys();

    expect(storage.entries.size).toBe(0);
    expect(restoreVaultKeys('user-1')).toBe(false);
  });

  it('is cleared by a lock even when this tab was holding nothing', () => {
    // A reloaded tab that has not restored yet holds no keys and still has a
    // mirror. The idle timer firing there, or a lock broadcast from another
    // tab, has to remove it — otherwise the next reload adopts it.
    const storage = fakeStorage();
    setMirrorStorage(storage);
    holdVaultKeys(material(11));
    const blob = storage.entries.get(VAULT_SESSION_MIRROR_KEY) as string;
    releaseVaultKeys();
    storage.entries.set(VAULT_SESSION_MIRROR_KEY, blob);

    expect(vaultKeysHeld()).toBe(false);
    releaseVaultKeys();

    expect(storage.entries.size).toBe(0);
  });
});

/**
 * Reconciling with the server's own answer.
 *
 * Three rules that pull against each other, which is why the decision is a
 * function rather than a condition at a call site: the answer has to be honoured
 * when it arrives late, ignored when it is older than a passphrase the user has
 * just typed, and — the case this was written for — honoured on the *first*
 * answer a reloaded tab receives.
 */
describe('what a server verdict of locked does to a tab', () => {
  const held = { previous: true, unlockedSinceMount: false };

  it('releases on a true → false transition', () => {
    // A lock pressed on a phone, a session revoked elsewhere, the eight-hour
    // ceiling: all of them reach this tab as a status that used to say unlocked.
    expect(shouldReleaseForServerVerdict({ ...held, current: false })).toBe(true);
  });

  it('releases on the very first answer, which is what a reloaded tab gets', () => {
    // The regression. A reloaded tab restores its mirror during its first
    // render, so it holds live keys before any status has arrived. Under a pure
    // transition check the first `unlocked: false` was a no-op — the lock screen
    // rendered over a key store that was still handing the full key set to any
    // tab that asked for it.
    expect(
      shouldReleaseForServerVerdict({
        previous: null,
        current: false,
        unlockedSinceMount: false,
      }),
    ).toBe(true);
  });

  it('does not release an unlock this tab performed while the first answer was in flight', () => {
    // Why this is not simply a level check. `unlockWithPassphrase` hands the
    // keys to the store and does not touch the cached `/api/auth/vault`
    // response, so the answer that lands a moment later still reads locked —
    // and acting on it would wipe a correct passphrase microseconds after it
    // was accepted.
    expect(
      shouldReleaseForServerVerdict({ previous: null, current: false, unlockedSinceMount: true }),
    ).toBe(false);
    expect(
      shouldReleaseForServerVerdict({ previous: false, current: false, unlockedSinceMount: true }),
    ).toBe(false);
  });

  it('ignores an answer that says unlocked, and the absence of one', () => {
    expect(shouldReleaseForServerVerdict({ ...held, current: true })).toBe(false);
    expect(shouldReleaseForServerVerdict({ ...held, current: null })).toBe(false);
    expect(
      shouldReleaseForServerVerdict({ previous: null, current: null, unlockedSinceMount: false }),
    ).toBe(false);
  });

  it('does not release twice on a verdict that has not changed', () => {
    // `false → false` is the steady state of a locked tab polling its status.
    // Releasing on each one is harmless but says the rule is a level check,
    // which is the thing the test above rules out.
    expect(
      shouldReleaseForServerVerdict({ previous: false, current: false, unlockedSinceMount: false }),
    ).toBe(false);
  });
});

describe('subscribers', () => {
  it('is notified on unlock and on lock', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVaultKeys(listener);

    holdVaultKeys(material(2));
    releaseVaultKeys();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('is not notified by a lock that had nothing to release', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVaultKeys(listener);

    releaseVaultKeys();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops hearing about it once unsubscribed', () => {
    const listener = vi.fn();
    subscribeVaultKeys(listener)();

    holdVaultKeys(material(4));

    expect(listener).not.toHaveBeenCalled();
  });
});
