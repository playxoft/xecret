'use client';

import { zeroize } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { clearMirror, readMirror, sessionMirrorStorage, writeMirror } from './session-mirror';
import type { MirrorStorage } from './session-mirror';

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
 * Nothing is written to `localStorage`, IndexedDB, a cookie, a service worker
 * cache, or any server. There is no "remember this device": every one of those
 * survives the tab, and a User Key that survives the tab is a User Key that
 * outlives the person sitting at the machine.
 *
 * One exception, added deliberately and argued in full in `session-mirror.ts`:
 * an unlocked key set is mirrored into **`sessionStorage`**, which is scoped to
 * this tab and dies with it. That is what makes a page reload — a deploy, an
 * accidental ⌘R, a crash — stop costing a master passphrase. The mirror is
 * written by {@link holdVaultKeys}, read only by {@link restoreVaultKeys}
 * against the account it belongs to, and removed by {@link releaseVaultKeys}
 * before the in-memory wipe is even scheduled.
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
 *
 * ── Why zeroization is *leased* rather than immediate ──
 * The wipe overwrites the very `Uint8Array` a caller is holding, and callers hold
 * them across `await`. An import encrypting forty entries, a save writing staged
 * changes one at a time, a rotation sealing to thirty recipients: every one of
 * those captured the key bytes before its first `await` and uses them after its
 * last. An idle timer firing in the middle of one used to overwrite the array in
 * place — and AES-GCM under an all-zero key does not fail. It produces a
 * perfectly well-formed ciphertext that nothing will ever open, uploads it, and
 * reports success.
 *
 * So the two halves of a lock are separated. The *visible* half — this store
 * reporting locked, every screen re-rendering, no new operation able to obtain
 * the material — happens immediately and unconditionally. The *destructive* half
 * waits for the last in-flight operation to finish, and then runs. Nothing is
 * kept alive that a new caller can reach: {@link readVaultKeys} answers `null`
 * from the instant the lock is requested, and {@link acquireCryptoLease} refuses
 * outright once one is pending, so an operation that has not begun cannot begin.
 * The bytes survive only for the operations that were already using them, which
 * is precisely the set that would otherwise have encrypted under zeroes.
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

/**
 * A claim on key material for the duration of one multi-step operation.
 *
 * Held by the operation, not by a component: it is acquired on the first line of
 * the work and released in a `finally`, and its whole job is to keep a
 * concurrently-requested wipe from landing between two `await`s.
 */
export interface CryptoLease {
  /** Idempotent, because it is called from a `finally` that may also throw. */
  release(): void;
}

/**
 * Refused because the material this operation needs is gone, or going.
 *
 * Distinct from a decryption failure on purpose. Nothing was corrupt and nothing
 * was wrong with the request — the vault locked, and the honest thing to tell
 * somebody is that they need to unlock and try again, not that their data would
 * not decrypt.
 */
export class VaultLockedError extends Error {
  constructor(message = 'The vault was locked before this finished. Unlock and try again.') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

let inFlight = 0;
let lockPending = false;
const deferredWipes: (() => void)[] = [];

/**
 * Claims the right to use key material until {@link CryptoLease.release}.
 *
 * Throws rather than blocking when a lock is already pending. Waiting would be
 * the wrong shape: the operation that would start is one somebody requested
 * *before* the lock and cannot now be authorised, and queueing it behind the wipe
 * would mean running it against material that no longer exists.
 */
export function acquireCryptoLease(): CryptoLease {
  if (lockPending) throw new VaultLockedError();

  inFlight += 1;
  let released = false;

  return {
    release(): void {
      if (released) return;
      released = true;
      inFlight -= 1;
      if (inFlight === 0) drainDeferredWipes();
    },
  };
}

/** How many multi-step crypto operations hold a lease. Test-facing. */
export function cryptoOperationsInFlight(): number {
  return inFlight;
}

/**
 * Runs `wipe` now, or after the last in-flight operation releases its lease.
 *
 * The store that owns the bytes has already forgotten them by the time this is
 * called — the deferral is about *when the array is overwritten*, never about
 * whether it is still reachable. `env-key-store.ts` defers on the same counter,
 * because an operation typically holds both a vault key and an environment key
 * and a lock has to mean the same thing to both.
 */
export function deferWipe(wipe: () => void): void {
  if (inFlight === 0) {
    wipe();
    return;
  }

  lockPending = true;
  deferredWipes.push(wipe);
}

function drainDeferredWipes(): void {
  lockPending = false;
  const pending = deferredWipes.splice(0);
  for (const wipe of pending) wipe();
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
  const superseded = held;
  held = keys;
  writeMirror(storage(), keys);
  notify();
  if (superseded !== null) deferWipe(() => wipe(superseded));
}

/**
 * Re-adopts the key set this tab mirrored before it was reloaded.
 *
 * ── Why this is a separate function and not something `readVaultKeys` does ──
 * Because it needs to know *whose* keys are expected, and the store deliberately
 * does not: a session that expires is a redirect to sign-in with no lock in
 * between, so the mirror can outlive its own account inside one tab. The caller
 * — `VaultProvider`, which always mounts below a resolved session — is the first
 * place that knows the answer, and passing it in is what turns "there is a blob
 * here" into "there is *your* blob here".
 *
 * Idempotent and safe to call while unlocked: a tab that already holds keys is a
 * tab whose keys are newer than anything in storage, so nothing happens. The
 * return value says whether anything was adopted, for a caller that wants to
 * know whether to ask other tabs instead.
 */
export function restoreVaultKeys(expectedUserId: string): boolean {
  if (held !== null) return true;

  const restored = readMirror(storage(), expectedUserId);
  if (restored === null) return false;

  holdVaultKeys(restored);
  return true;
}

/**
 * Swaps in a different storage for the mirror. Test-facing, and only that.
 *
 * The tests run without a DOM, and the ones worth having are about the round
 * trip — that a restore hands back the same bytes, that a lock leaves nothing
 * behind — which needs a storage that can be inspected. Passing `null` restores
 * the real `sessionStorage` lookup.
 */
export function setMirrorStorage(next: MirrorStorage | null): void {
  overriddenStorage = next;
}

let overriddenStorage: MirrorStorage | null = null;

function storage(): MirrorStorage | null {
  return overriddenStorage ?? sessionMirrorStorage();
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
  // Unconditionally, and before the early return: a mirror with nothing held is
  // exactly the state a *reloaded* tab is in, and a lock arriving in that state
  // — the idle timer firing before anything restored, a lock broadcast from
  // another tab — has to be able to remove it. Returning early would leave the
  // blob for the next reload to adopt.
  clearMirror(storage());

  if (held === null) return;
  const orphaned = held;
  // Locked *now*, whatever the bytes are doing: every reader sees `null` from
  // this line onward and `acquireCryptoLease` starts refusing. Only the
  // overwrite waits, and only for operations that already hold a lease.
  held = null;
  notify();
  deferWipe(() => wipe(orphaned));
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
 * Runs one multi-step operation against vault keys that cannot be wiped under it.
 *
 * The identity check is the load-bearing line. `keys` reached the caller as a
 * value — from a React render, from a prop, from a closure built three awaits
 * ago — and the only way to know it is still *the* material rather than a
 * superseded copy is to compare it against what the store holds, after the lease
 * is taken. A lock that landed before the lease fails here, before a single byte
 * is encrypted; a lock that lands after it is deferred until the `finally`.
 */
export async function withVaultKeys<T>(keys: VaultKeyMaterial, run: () => Promise<T>): Promise<T> {
  const lease = acquireCryptoLease();
  try {
    if (held !== keys) throw new VaultLockedError();
    return await run();
  } finally {
    lease.release();
  }
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
