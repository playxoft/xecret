'use client';

import { fromBase64Url, toBase64Url } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import type { VaultKeyMaterial } from './key-store';

/**
 * The tab-lifetime copy of an unlocked vault, and the only storage this client
 * ever writes key material to.
 *
 * ── What changed, and the argument for changing it ──
 * `key-store.ts` used to promise that nothing was ever written to any storage at
 * all. The promise cost a passphrase on every reload — every deploy of the app,
 * every accidental ⌘R, every crash — which is the kind of friction that makes
 * people choose a shorter auto-lock interval, or a weaker passphrase, or a
 * different product. What it bought was less than it appeared to:
 *
 *  - **`sessionStorage` is not disk in the way `localStorage` is.** It is scoped
 *    to one tab, cleared when that tab closes, never shared with another tab,
 *    and never restored by "reopen my windows" in the ordinary case.
 *  - **XSS was already terminal here.** A script running on this origin can read
 *    the module singleton, hook `unwrapUserKey`, or simply read the passphrase
 *    out of the input as it is typed. A web E2EE client that survives XSS does
 *    not exist, and pretending storage is the boundary misplaces the threat.
 *  - **What it does *not* touch: `localStorage`, IndexedDB, cookies, the cache
 *    API, or any server.** Those survive the tab, and a User Key that survives
 *    the tab is a User Key that outlives the person sitting at the machine.
 *
 * So the trade is bounded and deliberate: a reload no longer costs a passphrase;
 * closing the tab still does, and so does locking.
 *
 * ── What cannot be promised about a mirrored key ──
 * The blob is a `String` in the storage area, and a `String` cannot be wiped —
 * the same limitation `packages/core/src/crypto/encoding.ts` records about the
 * passphrase itself. `removeItem` unlinks it and the engine reclaims it when it
 * chooses. Zeroization applies to the `Uint8Array`s the key store holds and to
 * nothing here, which is why {@link clearMirror} is described as *clearing*
 * rather than as wiping.
 */

/**
 * The storage key, carrying its format version.
 *
 * Versioned in the name rather than only in the payload so that a future format
 * is a *different key*: a client that only knows v1 ignores a v2 blob without
 * having to parse it, and a rollback does not find a newer shape under the name
 * it expects. The `xecret.` prefix keeps it out of the way of anything else on
 * the origin.
 */
export const VAULT_SESSION_MIRROR_KEY = 'xecret.uk.session.v1';

/** The format {@link encodeMirror} writes and {@link decodeMirror} will accept. */
const MIRROR_VERSION = 1;

/**
 * The subset of `Storage` this module uses.
 *
 * A seam rather than a direct reach for `window.sessionStorage`, for two
 * reasons that both bite in practice: the tests run without a DOM, and a browser
 * in private mode or with site data blocked throws on `setItem` rather than
 * failing quietly. Everything here treats storage as something that may not
 * exist and may refuse.
 */
export interface MirrorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * This tab's `sessionStorage`, or `null` where there is none.
 *
 * `null` on the server, in a test, and in a browser that refuses storage — all
 * three mean the same thing to every caller: no mirror, so a reload costs a
 * passphrase. That is the old behaviour, which is the correct thing to degrade
 * to.
 */
export function sessionMirrorStorage(): MirrorStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Reading the property itself throws in a browser configured to block site
    // data. There is nothing to report and nothing to do about it.
    return null;
  }
}

/**
 * The on-the-wire shape, as it sits in storage.
 *
 * Base64url rather than an array of numbers: it is a third of the size, it is
 * the encoding every other serialized key in this codebase uses, and a
 * `JSON.parse` of a 32-element array allocates 32 boxed numbers to build one
 * `Uint8Array`.
 */
interface MirrorBlob {
  v: number;
  userId: string;
  uk: string;
  encSk: string;
  encPk: string;
  signSk: string;
  signPk: string;
}

/** Serialises a held key set. The caller keeps ownership of the arrays. */
export function encodeMirror(keys: VaultKeyMaterial): string {
  const blob: MirrorBlob = {
    v: MIRROR_VERSION,
    userId: keys.userId,
    uk: toBase64Url(keys.userKey),
    encSk: toBase64Url(keys.encPrivateKey),
    encPk: toBase64Url(keys.encPublicKey),
    signSk: toBase64Url(keys.signPrivateKey),
    signPk: toBase64Url(keys.signPublicKey),
  };
  return JSON.stringify(blob);
}

/**
 * Parses a mirrored blob, or answers `null` for anything it is not sure about.
 *
 * ── One failure mode, and it is "no keys" ──
 * Truncated JSON, a version this build does not know, a field that is not
 * base64url, a User Key that is not 32 bytes, a blob belonging to a different
 * account: every one of them returns `null`, and `null` means the lock screen.
 * Throwing would be worse in the one place it matters — the restore runs during
 * a render, and an exception there would replace the dashboard with an error
 * boundary rather than with the passphrase field that actually fixes it.
 *
 * `expectedUserId` is not a formality. A session that expires is a redirect to
 * sign-in with no lock in between, so the mirror survives into whoever signs in
 * next *in that same tab*. Without this comparison, that person's dashboard
 * would mount holding the previous account's User Key.
 */
export function decodeMirror(raw: string | null, expectedUserId: string): VaultKeyMaterial | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const blob = parsed as Partial<MirrorBlob>;

  if (blob.v !== MIRROR_VERSION) return null;
  if (typeof blob.userId !== 'string' || blob.userId !== expectedUserId) return null;

  const userKey = decodeBytes(blob.uk, 32);
  const encPrivateKey = decodeBytes(blob.encSk);
  const encPublicKey = decodeBytes(blob.encPk);
  const signPrivateKey = decodeBytes(blob.signSk);
  const signPublicKey = decodeBytes(blob.signPk);

  if (
    userKey === null ||
    encPrivateKey === null ||
    encPublicKey === null ||
    signPrivateKey === null ||
    signPublicKey === null
  ) {
    return null;
  }

  return {
    userId: blob.userId,
    userKey,
    encPrivateKey,
    encPublicKey,
    signPrivateKey,
    signPublicKey,
  };
}

/**
 * Writes the mirror, or does nothing it can report.
 *
 * A storage quota error, private browsing, a blocked origin: none of them is
 * worth failing an unlock over. The cost of a silent failure here is precisely
 * one retyped passphrase after a reload, which is what the product did before
 * this file existed.
 */
export function writeMirror(storage: MirrorStorage | null, keys: VaultKeyMaterial): void {
  if (storage === null) return;
  try {
    storage.setItem(VAULT_SESSION_MIRROR_KEY, encodeMirror(keys));
  } catch {
    // Deliberately silent — see above.
  }
}

/** Reads the mirror, if it is this account's and this build understands it. */
export function readMirror(
  storage: MirrorStorage | null,
  expectedUserId: string,
): VaultKeyMaterial | null {
  if (storage === null) return null;
  try {
    return decodeMirror(storage.getItem(VAULT_SESSION_MIRROR_KEY), expectedUserId);
  } catch {
    return null;
  }
}

/**
 * Removes the mirror.
 *
 * Called on every lock, before the in-memory wipe is even scheduled: the
 * in-memory arrays are lease-bound because an operation may still be encrypting
 * with them, while this is a copy nobody holds a reference to, so there is
 * nothing to wait for and every reason not to.
 */
export function clearMirror(storage: MirrorStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(VAULT_SESSION_MIRROR_KEY);
  } catch {
    // Same reasoning as `writeMirror`. A failure to clear is not silent in
    // effect — the keys are gone from memory either way, and the next restore
    // hands back material the server will refuse to serve a locked session for.
  }
}

/** Base64url to bytes, refusing anything of the wrong shape or length. */
function decodeBytes(value: unknown, exactLength?: number): Bytes | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  let bytes: Bytes;
  try {
    bytes = fromBase64Url(value);
  } catch {
    return null;
  }

  if (bytes.length === 0) return null;
  if (exactLength !== undefined && bytes.length !== exactLength) return null;
  return bytes;
}
