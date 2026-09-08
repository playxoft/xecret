'use client';

import { zeroize } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';

/**
 * The only place decrypted key material lives in the browser.
 *
 * ── Why a module singleton and not React state ──
 * Because the lifetime of these bytes is not the lifetime of a component tree.
 * The idle timer, the account menu's Lock button, a 401 from any request and the
 * eight-hour server ceiling all have to be able to say "these keys are gone
 * now", and several of them fire from outside React entirely. Holding the User
 * Key in `useState` would mean every one of those paths had to find a live
 * component to tell — and the one that could not find one would leave the key
 * resident in a closure nobody can reach but the process can still read.
 *
 * The React surface (`vault-keys.tsx`) is a subscription over this module, not a
 * second copy of it. `useSyncExternalStore` reads the same object.
 *
 * ── What is never done here ──
 * Nothing is written to `localStorage`, `sessionStorage`, IndexedDB, a cookie or
 * a service worker cache. There is no "remember this device". A vault that
 * survives a page reload is a vault whose keys are sitting on disk, and the
 * whole of ADR 0009 is an argument that they must not be.
 *
 * ── What zeroization does and does not buy ──
 * {@link releaseVaultKeys} overwrites every byte it holds. That is worth doing
 * and it is not a guarantee: the JavaScript engine may have copied a `Uint8Array`
 * during a GC compaction, and the passphrase itself was a `String` before it was
 * ever bytes — strings are immutable and cannot be wiped. So this shortens the
 * window in which a heap snapshot yields the User Key; it does not close it. The
 * same trade-off is recorded in `packages/core/src/crypto/encoding.ts` and in
 * the plan's threat model, and it is accepted deliberately rather than by
 * omission.
 */

/**
 * Everything an unlocked session holds.
 *
 * The private keys are here, not just the User Key, because unwrapping them is
 * an Argon2id-free operation the unlock has already paid for: re-deriving them
 * per use would mean keeping the UK around anyway and adding a decrypt to every
 * grant that gets opened. The public keys travel with them so that a caller
 * sealing to itself — the invite and rotation flows in Phase 3 — does not have
 * to re-read `/api/auth/vault` for a value it can compute.
 */
export interface VaultKeyMaterial {
  /** Whose keys these are. Bound into every wrap's AAD, so it is not optional. */
  userId: string;
  /** The 32-byte User Key. Wrapped several times on the server, derived never. */
  userKey: Bytes;
  encPrivateKey: Bytes;
  encPublicKey: Bytes;
  signPrivateKey: Bytes;
  signPublicKey: Bytes;
}

let held: VaultKeyMaterial | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The keys this session holds, or `null` when it is locked. */
export function readVaultKeys(): VaultKeyMaterial | null {
  return held;
}

/** Whether this browser can currently decrypt anything. */
export function vaultKeysHeld(): boolean {
  return held !== null;
}

/**
 * Takes ownership of a freshly unwrapped set of keys.
 *
 * Ownership is the operative word: the arrays are not copied, and the caller
 * must not keep a reference to them, because {@link releaseVaultKeys} will
 * overwrite them in place. Any keys already held are zeroized first — an unlock
 * that arrives while another is resident (a passphrase change, a recovery, a
 * second tab racing the first) must not leave the superseded copy behind.
 */
export function holdVaultKeys(keys: VaultKeyMaterial): void {
  if (held !== null) wipe(held);
  held = keys;
  notify();
}

/**
 * Locks: overwrites every byte and forgets the object.
 *
 * Safe to call when already locked, and deliberately so — it is called from the
 * idle timer, from sign-out, from the Lock button and from the 401 path, and a
 * lock that threw when it was already locked would make three of those four
 * callers write a guard they would eventually get wrong.
 */
export function releaseVaultKeys(): void {
  if (held === null) return;
  wipe(held);
  held = null;
  notify();
}

function wipe(keys: VaultKeyMaterial): void {
  zeroize(keys.userKey);
  zeroize(keys.encPrivateKey);
  zeroize(keys.signPrivateKey);
  // The public keys are not secret and are deliberately left intact: they are
  // the values a later error message or fingerprint display may still want, and
  // wiping them would suggest they were sensitive.
}

/**
 * Subscribes to lock and unlock, for `useSyncExternalStore`.
 *
 * Returns the unsubscribe function React expects. Nothing here is debounced or
 * batched: the transitions are rare and each one changes what the whole
 * dashboard is allowed to render.
 */
export function subscribeVaultKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
