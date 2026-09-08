'use client';

import { zeroize } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { subscribeVaultKeys, vaultKeysHeld } from '@/components/vault/key-store';

/**
 * The opened environment keys this session holds.
 *
 * ── Why a second store, beside the vault's ──
 * `components/vault/key-store.ts` holds the User Key and the two private keys:
 * one set, for one person, for the life of an unlock. This holds a *set per
 * environment per key version*, and it is derived from the other — an EDK is
 * what you get by opening a grant with the vault's X25519 key. Two different
 * lifetimes, two different shapes, and merging them would mean the User Key's
 * store grew a map keyed on a resource id.
 *
 * They are not independent, though, and that is the load-bearing part: **a vault
 * lock empties this one**. The subscription below is registered once, at module
 * scope, so it holds whether or not any component that reads environment keys is
 * mounted. Without it, locking the vault would leave every environment key the
 * session had opened sitting in a module map — the idle timer would fire, the
 * lock screen would appear, and a decrypted production data key would still be
 * one `readEnvKey` call away.
 *
 * ── Keyed by environment **and** EDK id ──
 * Not by environment alone. A rotation replaces the key while the id of the
 * environment stays the same, and a cache keyed only on the environment would
 * keep handing out the retired EDK: every value written after the rotation would
 * fail to decrypt, and — much worse — every value *written* would be sealed
 * against a key the server no longer accepts. Keying on the pair makes a
 * rotation a cache miss, which is what it is.
 *
 * Entries for retired keys are kept deliberately: a historical secret version is
 * still encrypted under the key that was active when it was written, so version
 * history needs exactly the key a naive eviction would drop.
 *
 * ── Nothing is written to disk ──
 * Same rule, same reason as the vault's store. This is a `Map` in a module and
 * it dies with the page. `pins.ts` is the one file in this directory that
 * touches `localStorage`, and it holds public keys.
 */

/** One environment's opened key material, at one EDK version. */
export interface EnvKeyMaterial {
  environmentId: string;
  /** The `env_data_keys` row these bytes came out of. */
  envDataKeyId: string;
  edkVersion: number;
  /** The Environment Data Key. Encrypts and decrypts values and notes. */
  edk: Bytes;
  /** The Environment HMAC Key. Long-lived; survives EDK rotation by design. */
  ehk: Bytes;
}

const held = new Map<string, EnvKeyMaterial>();

const listeners = new Set<() => void>();

/** Where an entry is filed. Both halves are uuids, so `:` cannot collide. */
export function envKeyCacheKey(environmentId: string, envDataKeyId: string): string {
  return `${environmentId}:${envDataKeyId}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The material for one environment at one key version, or `null`. */
export function readEnvKey(environmentId: string, envDataKeyId: string): EnvKeyMaterial | null {
  return held.get(envKeyCacheKey(environmentId, envDataKeyId)) ?? null;
}

/**
 * Takes ownership of freshly opened key material.
 *
 * Ownership as in the vault's store: the arrays are not copied, and the caller
 * must not keep a reference, because {@link releaseEnvKeys} overwrites them in
 * place. An entry already filed under the same pair is left alone and the new
 * bytes are wiped — two tabs racing to open the same grant produce identical
 * material, and replacing the resident copy would invalidate references a
 * decryption in flight is holding.
 */
export function holdEnvKey(material: EnvKeyMaterial): void {
  const key = envKeyCacheKey(material.environmentId, material.envDataKeyId);
  const existing = held.get(key);
  if (existing !== undefined) {
    zeroize(material.edk);
    zeroize(material.ehk);
    return;
  }

  held.set(key, material);
  notify();
}

/**
 * Overwrites every byte and forgets everything.
 *
 * Safe to call when empty, and deliberately so: it is called from the vault
 * subscription, from a sign-out, and from the reset path, and a version that
 * threw when there was nothing to clear would make each of those write a guard.
 */
export function releaseEnvKeys(): void {
  if (held.size === 0) return;
  for (const material of held.values()) {
    zeroize(material.edk);
    zeroize(material.ehk);
  }
  held.clear();
  notify();
}

/**
 * Drops one environment's material, at every key version.
 *
 * For the case the pair-keying does not cover: a grant that was *revoked*. The
 * bytes are still openable and still in memory, and keeping them would let this
 * tab keep reading an environment it has just been told it may not.
 */
export function releaseEnvironment(environmentId: string): void {
  let changed = false;
  for (const [key, material] of held) {
    if (material.environmentId !== environmentId) continue;
    zeroize(material.edk);
    zeroize(material.ehk);
    held.delete(key);
    changed = true;
  }
  if (changed) notify();
}

/** Subscribes to opens and releases, for `useSyncExternalStore`. */
export function subscribeEnvKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many environment keys this session currently holds. Test-facing. */
export function envKeyCount(): number {
  return held.size;
}

/**
 * The lock that empties this store.
 *
 * Registered at module scope on purpose. The alternative — an effect inside a
 * provider — would only run while something that reads environment keys is
 * mounted, and the moment that matters is precisely the moment the dashboard
 * unmounts its tables and shows the lock screen. `vaultKeysHeld()` is checked
 * rather than assuming the callback means "locked", because the same
 * subscription fires on unlock too.
 */
if (typeof window !== 'undefined') {
  subscribeVaultKeys(() => {
    if (!vaultKeysHeld()) releaseEnvKeys();
  });
}
