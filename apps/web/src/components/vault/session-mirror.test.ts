import { describe, expect, it } from 'vitest';

import {
  VAULT_SESSION_MIRROR_KEY,
  clearMirror,
  decodeMirror,
  encodeMirror,
  readMirror,
  writeMirror,
} from './session-mirror';
import type { MirrorStorage } from './session-mirror';
import type { VaultKeyMaterial } from './key-store';

/**
 * The one storage this client writes key material to, and the rules that make
 * that acceptable.
 *
 * Every assertion here is about something the product says out loud: that a
 * reload keeps the same keys rather than the same *shape* of keys, that a blob
 * belonging to somebody else is refused, that a corrupt blob produces a lock
 * screen rather than an exception during a render, and that locking leaves
 * nothing behind. None of them is visible on screen — a wrong answer looks like
 * "you have to type your passphrase again", or worse, like nothing at all.
 */

function material(fill: number, userId = 'user-1'): VaultKeyMaterial {
  return {
    userId,
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

/** A `sessionStorage` that can be inspected. The tests run without a DOM. */
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

describe('the mirrored blob', () => {
  it('round-trips every byte, not merely every field', () => {
    const keys = material(7);
    const restored = decodeMirror(encodeMirror(keys), 'user-1');

    expect(restored).not.toBeNull();
    expect([...(restored as VaultKeyMaterial).userKey]).toEqual([...keys.userKey]);
    expect([...(restored as VaultKeyMaterial).encPrivateKey]).toEqual([...keys.encPrivateKey]);
    expect([...(restored as VaultKeyMaterial).encPublicKey]).toEqual([...keys.encPublicKey]);
    expect([...(restored as VaultKeyMaterial).signPrivateKey]).toEqual([...keys.signPrivateKey]);
    expect([...(restored as VaultKeyMaterial).signPublicKey]).toEqual([...keys.signPublicKey]);
  });

  it('hands back fresh arrays, so the key store owns what it wipes', () => {
    // `holdVaultKeys` takes ownership and `releaseVaultKeys` overwrites in
    // place. A decode that aliased anything the caller still held would make a
    // lock wipe somebody else's array.
    const keys = material(7);
    const restored = decodeMirror(encodeMirror(keys), 'user-1') as VaultKeyMaterial;

    expect(restored.userKey).not.toBe(keys.userKey);
    restored.userKey.fill(0);
    expect(keys.userKey.some((byte) => byte !== 0)).toBe(true);
  });

  it('refuses a blob belonging to another account', () => {
    // A session that expires is a redirect to sign-in with no lock in between,
    // so the mirror outlives its own account inside one tab. Without this, the
    // next person to sign in there would mount holding the previous User Key.
    expect(decodeMirror(encodeMirror(material(7, 'user-1')), 'user-2')).toBeNull();
  });

  it('refuses anything it cannot be certain about, rather than throwing', () => {
    // The restore runs during a render. An exception there replaces the
    // dashboard with an error boundary instead of with the passphrase field
    // that would actually fix it.
    const valid = JSON.parse(encodeMirror(material(7))) as Record<string, unknown>;

    for (const [name, blob] of [
      ['null', null],
      ['not JSON', '{'],
      ['not an object', '"a string"'],
      ['a future version', JSON.stringify({ ...valid, v: 2 })],
      ['no version', JSON.stringify({ ...valid, v: undefined })],
      ['a missing key', JSON.stringify({ ...valid, uk: undefined })],
      ['an empty key', JSON.stringify({ ...valid, uk: '' })],
      ['a non-base64url key', JSON.stringify({ ...valid, uk: '!!!!' })],
      ['a truncated User Key', JSON.stringify({ ...valid, uk: 'AAAA' })],
      ['a numeric user id', JSON.stringify({ ...valid, userId: 1 })],
    ] as const) {
      expect(decodeMirror(blob, 'user-1'), name).toBeNull();
    }
  });
});

describe('the storage round trip', () => {
  it('writes under the versioned key and reads back what it wrote', () => {
    const storage = fakeStorage();
    const keys = material(3);

    writeMirror(storage, keys);

    expect([...storage.entries.keys()]).toEqual([VAULT_SESSION_MIRROR_KEY]);
    expect([...(readMirror(storage, 'user-1') as VaultKeyMaterial).userKey]).toEqual([
      ...keys.userKey,
    ]);
  });

  it('leaves nothing behind when cleared', () => {
    const storage = fakeStorage();
    writeMirror(storage, material(3));

    clearMirror(storage);

    expect(storage.entries.size).toBe(0);
    expect(readMirror(storage, 'user-1')).toBeNull();
  });

  it('degrades to "no mirror" where there is no storage at all', () => {
    // Server rendering, a test, private browsing, an origin with site data
    // blocked. All four mean one passphrase after a reload, which is exactly
    // what the product did before the mirror existed.
    expect(() => writeMirror(null, material(3))).not.toThrow();
    expect(() => clearMirror(null)).not.toThrow();
    expect(readMirror(null, 'user-1')).toBeNull();
  });

  it('does not fail an unlock because storage refused the write', () => {
    const refusing: MirrorStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };

    expect(() => writeMirror(refusing, material(3))).not.toThrow();
    expect(() => clearMirror(refusing)).not.toThrow();
    expect(readMirror(refusing, 'user-1')).toBeNull();
  });
});
