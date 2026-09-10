import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  holdVaultKeys,
  readVaultKeys,
  releaseVaultKeys,
  subscribeVaultKeys,
  vaultKeysHeld,
} from './key-store';

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

function material(fill: number) {
  return {
    userId: 'user-1',
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

afterEach(() => {
  releaseVaultKeys();
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
