'use client';

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { readVaultKeys, releaseVaultKeys, subscribeVaultKeys } from './key-store';
import type { VaultKeyMaterial } from './key-store';
import { lockVault } from './vault-client';
import type { VaultMaterial, VaultResponse, VaultStatus } from './vault-client';

/**
 * The React surface over the vault: the keys this browser holds, and the
 * material it needs in order to obtain them.
 *
 * ── Two different things, deliberately kept apart ──
 * The **keys** live in `key-store.ts`, a module singleton, because their
 * lifetime is not a component's — see that file's header. This context does not
 * copy them; it subscribes, so `useVaultKeys()` and a lock fired from outside
 * React can never disagree.
 *
 * The **material** — the wraps, the public keys, the KDF parameters, the enrolled
 * passkeys — is ordinary server state, read through `useApiResource` like every
 * other screen's data. It is not secret (`VaultMaterialPayload` says why it is
 * served to a locked session), it changes when a passphrase or a passkey does,
 * and every route that changes it answers with the new copy — which the overlay
 * below adopts without a second round trip. Holding it in one place is what
 * stops the lock screen and the security card each fetching their own and
 * drifting apart after a passphrase change.
 *
 * ── Where the idle timer is ──
 * Not here. `DashboardChrome` already owns `useAutoLock`, driven by
 * `vault.autoLockMinutes` from the session, and it calls the same {@link
 * lockVault} this context's `lock` does — which zeroizes in a `finally`. Adding
 * a second timer would mean two things could disagree about when a laptop went
 * idle.
 */

export interface VaultContextValue {
  /** The decrypted keys, or `null` while locked. Re-renders on lock and unlock. */
  keys: VaultKeyMaterial | null;
  /** Whether this browser can decrypt. Not the same as the server's unlocked flag. */
  unlocked: boolean;
  /** The wraps and public artefacts. `null` before the first read, or with no vault. */
  material: VaultMaterial | null;
  /** The server's view: configured, unlocked, and the idle allowance. */
  status: VaultStatus | null;
  loading: boolean;
  error: unknown;
  /** Re-reads `GET /api/auth/vault`. */
  reload: () => Promise<void>;
  /**
   * Replaces the cached material without a round trip.
   *
   * Every mutating vault route answers with the new material precisely so this
   * is possible: a client still holding the superseded passphrase wrap would
   * fail its next unlock against a row that has moved on.
   */
  adopt: (next: { vault?: VaultStatus; material?: VaultMaterial }) => void;
  /** Locks the server session and zeroizes everything this browser holds. */
  lock: (everywhere?: boolean) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

/**
 * Reads the key store.
 *
 * Exported on its own because most consumers want only this — a component
 * deciding whether it may decrypt has no use for the wraps — and because it
 * works outside the provider, which the module singleton underneath it does too.
 */
export function useVaultKeys(): VaultKeyMaterial | null {
  return useSyncExternalStore(subscribeVaultKeys, readVaultKeys, serverSnapshot);
}

/** Nothing is ever unlocked during server rendering, and nothing may pretend it is. */
function serverSnapshot(): null {
  return null;
}

/**
 * A local answer layered over the last one the server gave.
 *
 * `base` is the exact response object the overlay was built on top of, compared
 * by identity. When `useApiResource` produces a newer one the overlay is
 * discarded during render rather than cleared by an effect — the server's answer
 * is by definition fresher than a copy this tab has been carrying, and
 * synchronising two pieces of state through an effect is the cascading render
 * the React lint rule exists to prevent.
 */
interface VaultOverlay {
  base: VaultResponse | null;
  vault?: VaultStatus;
  material?: VaultMaterial;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const keys = useVaultKeys();

  // The dashboard's own fetch hook, for the same reasons every other screen
  // uses it: one place that handles the abort on unmount, the 401 redirect, and
  // an awaitable retry.
  const resource = useApiResource<VaultResponse>(apiPath.vault());
  const [overlay, setOverlay] = useState<VaultOverlay>({ base: null });

  const answer = resource.data;
  const live = overlay.base === answer ? overlay : null;

  const status = live?.vault ?? answer?.vault ?? null;
  const material = live?.material ?? answer?.material ?? null;

  const adopt = useCallback(
    (next: { vault?: VaultStatus; material?: VaultMaterial }) => {
      setOverlay((current) => ({
        ...(current.base === answer ? current : { base: answer }),
        ...next,
      }));
    },
    [answer],
  );

  const lock = useCallback(
    async (everywhere = false) => {
      // `lockVault` zeroizes in a `finally`, so the keys are gone even when the
      // request is not. The status is written optimistically for the same
      // reason: this browser is locked the moment the keys are wiped, whatever
      // the network has to say about it.
      try {
        await lockVault(everywhere);
      } finally {
        if (status !== null) adopt({ vault: { ...status, unlocked: false, unlockedUntil: null } });
      }
    },
    [adopt, status],
  );

  /**
   * A lock this tab never saw, arriving from the server.
   *
   * The eight-hour ceiling, "lock every device" pressed on a phone, a session
   * revoked elsewhere: all of them reach this tab as a `/api/auth/vault` read
   * that says `unlocked: false`, and a browser holding decrypted keys against a
   * session the API refuses is worth an effect to reconcile.
   *
   * ── Why this watches a *transition*, and only the server's own answer ──
   * A level check — "the status says locked, so release" — is wrong here, and
   * wrong in the direction that loses a working unlock. Unlocking does not
   * change the server answer this provider is holding: `unlockWithPassphrase`
   * hands the keys to the store and the fresh status to its caller, and the
   * cached `/api/auth/vault` response still reads `unlocked: false` until
   * something reloads it. A level check would therefore fire on the very render
   * that the newly held keys cause, and wipe them microseconds after a correct
   * passphrase.
   *
   * So it fires only on `true → false`, and only on `answer` — the resource's
   * own data — never on the overlay, whose optimistic lock is already
   * accompanied by the zeroization inside `lockVault`.
   */
  const serverUnlocked = answer === undefined || answer === null ? null : answer.vault.unlocked;
  const previousServerUnlocked = useRef<boolean | null>(null);
  useEffect(() => {
    if (previousServerUnlocked.current === true && serverUnlocked === false) releaseVaultKeys();
    previousServerUnlocked.current = serverUnlocked;
  }, [serverUnlocked]);

  return (
    <VaultContext
      value={{
        keys,
        unlocked: keys !== null,
        material,
        status,
        loading: resource.loading,
        error: resource.error,
        reload: resource.reload,
        adopt,
        lock,
      }}
    >
      {children}
    </VaultContext>
  );
}

/**
 * Throws outside the provider rather than answering "locked".
 *
 * A screen that silently rendered as though the vault were locked would be
 * indistinguishable from one that is, and the wiring bug behind it would survive
 * review. Every consumer is below `VaultProvider`, which the dashboard shell and
 * the CLI authorisation page both mount.
 */
export function useVault(): VaultContextValue {
  const value = use(VaultContext);
  if (!value) throw new Error('useVault must be used inside <VaultProvider>.');
  return value;
}
