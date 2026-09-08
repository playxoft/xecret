'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useVaultKeys } from '@/components/vault/vault-keys';
import { fetchEnvironmentKeys, keysPath, openEnvironmentKeys } from './env-keys';
import type { EnvKeyUnavailable, EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
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

  const { orgSlug, projectSlug, envSlug, orgId } = target;
  const path = keysPath({ orgSlug, projectSlug, envSlug });

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

    (async () => {
      try {
        const keys = await fetchEnvironmentKeys(
          { orgSlug, projectSlug, envSlug },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        const context = { orgSlug, orgId: orgId ?? '', projectSlug, envSlug };

        if (keys.encryptionMode !== 'e2ee') {
          setState({ status: 'server', keys, io: serverSecretIo(context) });
          return;
        }

        // The organisation id is an AAD component of every value in this
        // environment, and it comes from the session. Without it nothing can be
        // encrypted or decrypted, so the environment reads as unopenable rather
        // than opening into an IO whose first call would fail.
        if (orgId === null) {
          setState({ status: 'unavailable', keys, reason: 'locked' });
          return;
        }

        const opened = await openEnvironmentKeys(keys, vault);
        if (controller.signal.aborted) return;

        if (opened.status !== 'open') {
          setState({ status: 'unavailable', keys: opened.keys, reason: opened.reason });
          return;
        }

        setState({
          status: 'open',
          keys: opened.keys,
          material: opened.material,
          io: clientSecretIo(context, opened.material),
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: cause });
      }
    })();

    return () => controller.abort();
  }, [orgSlug, projectSlug, envSlug, orgId, vault, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  return useMemo(() => ({ state, reload }), [state, reload]);
}

/** The IO when there is one, or `null` while the environment cannot be used. */
export function ioOf(state: EnvironmentKeyState): SecretIo | null {
  return state.status === 'open' || state.status === 'server' ? state.io : null;
}
