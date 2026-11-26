'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useVaultKeys } from '@/components/vault/vault-keys';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { fetchEnvironmentKeys, keysPath, openEnvironmentKeys } from './env-keys';
import type { EnvKeyUnavailable, EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { admitEncryptionMode } from './pins';
import { clientSecretIo, serverSecretIo } from './secret-io';
import type { SecretIo } from './secret-io';
import type { EnvironmentKeys } from './types';

/**
 * One environment's key state, opened if it can be, plus the IO that follows
 * from it.
 *
 * ── Why the mode is not a prop ──
 * `encryptionMode` is on the environment payload, and a screen could read it
 * from there. It is read from `GET …/keys` instead, together with the grant,
 * because the two have to be one answer: a screen that learned "e2ee" from one
 * request and the grant from another has a window in which it believes it is
 * encrypted and holds no key, and the honest thing to render in that window is
 * not the pending state.
 *
 * ── Why the vault is a dependency and not a guard ──
 * `useVaultKeys` re-renders on lock and unlock, and the effect below re-runs. So
 * unlocking a vault while an environment screen is open opens the environment,
 * with no navigation and no button — which is what a person who has just typed
 * their passphrase expects. Locking clears the store (see `env-key-store.ts`)
 * and the same effect re-reports `locked`.
 */

export type EnvironmentKeyState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  /** Ready to read and write. `io` is the only thing most callers need. */
  | { status: 'open'; keys: EnvironmentKeys; material: EnvKeyMaterial; io: SecretIo }
  /** `server`-mode: no client key, and the plaintext IO is still usable. */
  | { status: 'server'; keys: EnvironmentKeys; io: SecretIo }
  /** `e2ee`, and this browser cannot open it. Nothing may be read or written. */
  | { status: 'unavailable'; keys: EnvironmentKeys; reason: EnvKeyUnavailable };

export interface EnvironmentKeyHandle {
  state: EnvironmentKeyState;
  /** Re-reads `GET …/keys` and re-opens. Called after a rotation or a share. */
  reload: () => void;
}

export function useEnvironmentKeys(
  target: EnvironmentRef & { orgId: string | null },
): EnvironmentKeyHandle {
  const vault = useVaultKeys();
  const [state, setState] = useState<EnvironmentKeyState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const { orgSlug, projectId, envSlug, orgId } = target;
  const path = keysPath({ orgSlug, projectId, envSlug });

  // Compared during render rather than in an effect: an effect runs after paint,
  // so a table rendered against the previous environment's key would be on
  // screen for a frame — and in that frame a row could be clicked into an
  // editor seeded from it.
  const [renderedPath, setRenderedPath] = useState(path);
  if (renderedPath !== path) {
    setRenderedPath(path);
    setState({ status: 'loading' });
  }

  useEffect(() => {
    const controller = new AbortController();

    void readEnvironmentKeyState(
      { orgSlug, projectId, envSlug, orgId },
      vault,
      controller.signal,
    ).then((next) => {
      if (next !== null && !controller.signal.aborted) setState(next);
    });

    return () => controller.abort();
  }, [orgSlug, projectId, envSlug, orgId, vault, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  return useMemo(() => ({ state, reload }), [state, reload]);
}

/**
 * One read of an environment's key state, checked and opened: what the hook
 * above renders. `null` once `signal` has aborted, when nothing should be.
 *
 * Out of the hook so that what it decides can be tested without a renderer —
 * the downgrade check above all.
 */
export async function readEnvironmentKeyState(
  target: EnvironmentRef & { orgId: string | null },
  vault: VaultKeyMaterial | null,
  signal: AbortSignal,
): Promise<EnvironmentKeyState | null> {
  const { orgSlug, projectId, envSlug, orgId } = target;

  try {
    const keys = await fetchEnvironmentKeys({ orgSlug, projectId, envSlug }, { signal });
    if (signal.aborted) return null;

    const context = { orgSlug, orgId: orgId ?? '', projectId, envSlug };

    // ── The mode is checked before it is believed ──
    // `encryptionMode` decides whether the editor above sends ciphertext or
    // **plaintext values in request bodies**. Nothing in the payload
    // authenticates it, so a server that flips it from `e2ee` to `server`
    // collects every value saved afterwards without breaking anything. The pin
    // is what makes that a refusal instead of a quiet success — see `pins.ts`.
    // Recorded here too, on the read path, because a browser that only pinned
    // on its first *write* would be unprotected on exactly the page load where
    // the downgrade is offered.
    //
    // A `server` answer at an address with no pin of its own waits for the
    // pins this browser filed under the project's slug to be carried to its
    // id, read from the project itself rather than left to the shell's trail,
    // which a server could simply hold back until this had decided. A project
    // that cannot be read here is an error, not a reason to believe `server`.
    const admitted = await admitEncryptionMode(
      { orgSlug, projectId, envSlug },
      keys.encryptionMode,
      async () => {
        const { project } = await api.get<{ project: { slug: string } }>(
          apiPath.project(orgSlug, projectId),
          { signal },
        );
        return [project.slug];
      },
    );
    if (signal.aborted) return null;
    if (!admitted) return { status: 'unavailable', keys, reason: 'downgraded' };

    if (keys.encryptionMode !== 'e2ee') {
      return { status: 'server', keys, io: serverSecretIo(context) };
    }

    // The organisation id is an AAD component of every value in this
    // environment, and it comes from the session. Without it nothing can be
    // encrypted or decrypted, so the environment reads as unopenable rather
    // than opening into an IO whose first call would fail.
    if (orgId === null) return { status: 'unavailable', keys, reason: 'locked' };

    const opened = await openEnvironmentKeys(keys, vault);
    if (signal.aborted) return null;

    if (opened.status !== 'open') {
      return { status: 'unavailable', keys: opened.keys, reason: opened.reason };
    }

    return {
      status: 'open',
      keys: opened.keys,
      material: opened.material,
      io: clientSecretIo(context, opened.material),
    };
  } catch (cause) {
    if (signal.aborted) return null;
    return { status: 'error', error: cause };
  }
}

/** The IO when there is one, or `null` while the environment cannot be used. */
export function ioOf(state: EnvironmentKeyState): SecretIo | null {
  return state.status === 'open' || state.status === 'server' ? state.io : null;
}
