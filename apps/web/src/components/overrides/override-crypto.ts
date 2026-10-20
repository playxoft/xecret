'use client';

import {
  BlobFormatError,
  DecryptionError,
  MAX_SECRET_VALUE_BYTES,
  openOverrideValue,
  sealOverrideValue,
  SecretTooLargeError,
} from '@xecret/core/crypto/client';
import type { OverrideContext } from '@xecret/core/crypto/client';
import { checkSecretName } from '@xecret/core/validation';
import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { withVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';

/**
 * Personal overrides (P19 §2), between a form and the wire.
 *
 * An override is one person's own value for one key in one environment: what
 * `xecret run` injects on *their* machine in place of the shared value, and
 * nowhere else. This module is the dashboard's whole contact with them — the
 * three routes, and the one cryptographic composition they need — so the card
 * that renders them never assembles an AAD or touches a private key itself.
 * It is to overrides what `components/envkeys/secret-crypto.ts` is to secrets.
 *
 * ── The key, and why it is the vault's ──
 * An override is sealed under a key derived from the owner's **own X25519
 * private key** (`@xecret/core/crypto/client`'s `sealOverrideValue`, spec §2.2
 * type 13), not under the environment's data key. That one choice is what makes
 * the promises true rather than merely enforced: a teammate holding the
 * environment's key cannot open one, the server cannot open one, and — because
 * the key is symmetric and only the owner can derive it — nobody but the owner
 * can *make* one their CLI would accept. A service token has no vault, so it can
 * neither read nor write one, which is why a CI run always gets the shared
 * values.
 *
 * ── The four AAD components, and where each comes from ──
 * `orgId` from the session, `environmentId` from the environment's key state
 * (`GET …/keys`), `userId` from the vault itself — the account whose private key
 * this is, which is also whose row the server files it under — and `name`, the
 * key it overrides. Getting any of them wrong produces a blob the server stores
 * happily and the owner's CLI refuses for ever, so they are assembled in exactly
 * one place: {@link overrideContext}.
 *
 * ── What may appear in an error ──
 * The rule, never the value. Every error this module throws is built from fixed
 * strings and the override's *name*, which is plaintext by design (it becomes an
 * environment variable, and the server stores it in the clear). Nothing here
 * logs, and nothing here puts a value in a message.
 */

/** Where an environment lives, as the API addresses it. */
export interface OverrideTarget {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

/** One override as `GET …/overrides` lists it: its name, its blob, and when it was last set. */
export interface StoredOverride {
  name: string;
  /** `xk2.gcm.` under the owner's override key. Opens for the owner and nobody else. */
  ciphertext: string;
  updatedAt: string;
}

export interface OverrideListResponse {
  overrides: StoredOverride[];
  /**
   * Whether this organisation's plan lets a *new* override be set
   * (`personalOverrides`, Pro). Reading and removing what you already have is
   * never gated — an organisation that downgraded keeps every override its
   * members set, and `xecret run` still applies them.
   */
  canSet: boolean;
  /** The cheapest plan that would allow setting one, or `null`. */
  upgradeTo: string | null;
}

export interface OverrideSetResponse {
  override: { name: string; updatedAt: string; created: boolean };
}

export interface OverrideRemoveResponse {
  override: { name: string; deleted: true };
}

/**
 * A name the secret-name grammar refuses, caught before anything is sealed.
 *
 * Overrides follow the grammar because each one becomes an environment variable
 * on the owner's machine — and the grammar is what keeps `LD_PRELOAD` and its
 * friends out of a process `xecret run` starts.
 */
export class OverrideNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverrideNameError';
  }
}

/** A value larger than a secret may be, caught before anything is sealed. */
export class OverrideTooLargeError extends Error {
  constructor() {
    super(`An override can be at most ${MAX_SECRET_VALUE_BYTES / 1024} KB, the same as a secret.`);
    this.name = 'OverrideTooLargeError';
  }
}

/**
 * An override this account cannot open.
 *
 * The one ordinary way to get here is a vault reset: it gives the account a new
 * key pair, and every override made under the old one stops opening — by
 * design, since the old private key no longer exists anywhere. A blob the
 * server altered, or moved from another row, fails the same tag check and lands
 * here too; the two are indistinguishable on purpose, and the remedy is the
 * same. Its own class, so the card can say what happened instead of "something
 * went wrong", and so nobody is sent to re-enter a passphrase that is fine.
 */
export class OverrideUnreadableError extends Error {
  constructor(name: string) {
    super(
      `The override for ${name} was made under a key your account no longer has — usually because ` +
        'the vault was reset since. Remove it and set it again.',
    );
    this.name = 'OverrideUnreadableError';
  }
}

/**
 * Why a name cannot be overridden, or `null` when it can. The same grammar the
 * server applies to the path segment, asked here so the answer arrives while
 * the name is still under the cursor.
 */
export function overrideNameProblem(name: string): string | null {
  const check = checkSecretName(name);
  return check.valid ? null : (check.message ?? 'That name cannot be used.');
}

/** The row an override belongs to. Named once, so no caller assembles one. */
export function overrideContext(params: {
  vault: VaultKeyMaterial;
  orgId: string;
  environmentId: string;
  name: string;
}): OverrideContext {
  return {
    orgId: params.orgId,
    environmentId: params.environmentId,
    userId: params.vault.userId,
    name: params.name,
  };
}

/** Reads the caller's own overrides in one environment. Ciphertext only — never opened here. */
export function listOverrides(
  target: OverrideTarget,
  options?: { signal?: AbortSignal },
): Promise<OverrideListResponse> {
  return api.get<OverrideListResponse>(
    apiPath.overrides(target.orgSlug, target.projectSlug, target.envSlug),
    options,
  );
}

/**
 * Seals a value for one name, under the owner's override key.
 *
 * Leased with `withVaultKeys`, because the seal reads the private key across an
 * `await`: a lock landing in the middle would otherwise overwrite the key in
 * place, and AES-GCM under an all-zero key does not fail — it produces a blob
 * that uploads cleanly and that the owner's CLI can never open. A lock that
 * lands first refuses here, with nothing sealed.
 */
export async function sealOverride(params: {
  vault: VaultKeyMaterial;
  orgId: string;
  environmentId: string;
  name: string;
  value: string;
}): Promise<string> {
  const problem = overrideNameProblem(params.name);
  if (problem !== null) throw new OverrideNameError(problem);

  return withVaultKeys(params.vault, async () => {
    try {
      return await sealOverrideValue({
        ownerPrivateKey: params.vault.encPrivateKey,
        context: overrideContext(params),
        value: params.value,
      });
    } catch (cause) {
      // Re-labelled rather than rethrown: the core error names a byte count,
      // which is harmless, but a message written for people is better than one
      // written for a log — and this is the only failure a seal has.
      if (cause instanceof SecretTooLargeError) throw new OverrideTooLargeError();
      throw cause;
    }
  });
}

/**
 * Sets — or replaces — the caller's override for one name.
 *
 * The body is `{ ciphertext }` and nothing else. The value never leaves this
 * function in plaintext: not in the body, not in the path (which carries only
 * the name), not in an error.
 */
export async function setOverride(params: {
  target: OverrideTarget;
  vault: VaultKeyMaterial;
  orgId: string;
  environmentId: string;
  name: string;
  value: string;
}): Promise<OverrideSetResponse> {
  const ciphertext = await sealOverride(params);
  return api.put<OverrideSetResponse>(
    apiPath.override(
      params.target.orgSlug,
      params.target.projectSlug,
      params.target.envSlug,
      params.name,
    ),
    { ciphertext },
  );
}

/**
 * Opens one of the caller's own overrides.
 *
 * Throws {@link OverrideUnreadableError} for a blob this account cannot open,
 * and `VaultLockedError` when the vault locked first. Never returns anything
 * but the plaintext the owner sealed: the tag is what proves the owner's own key
 * made this blob, for this row.
 */
export async function openOverride(params: {
  vault: VaultKeyMaterial;
  orgId: string;
  environmentId: string;
  override: Pick<StoredOverride, 'name' | 'ciphertext'>;
}): Promise<string> {
  return withVaultKeys(params.vault, async () => {
    try {
      return await openOverrideValue({
        ownerPrivateKey: params.vault.encPrivateKey,
        context: overrideContext({ ...params, name: params.override.name }),
        blob: params.override.ciphertext,
      });
    } catch (cause) {
      if (cause instanceof DecryptionError || cause instanceof BlobFormatError) {
        throw new OverrideUnreadableError(params.override.name);
      }
      throw cause;
    }
  });
}

/**
 * Removes the caller's override for one name. Needs no key and no plan:
 * removing what you have is never a feature, and it is exactly what somebody
 * whose overrides stopped opening after a vault reset has to be able to do.
 */
export function removeOverride(
  target: OverrideTarget,
  name: string,
): Promise<OverrideRemoveResponse> {
  return api.delete<OverrideRemoveResponse>(
    apiPath.override(target.orgSlug, target.projectSlug, target.envSlug, name),
  );
}

/**
 * The sentence a failure from this module is shown as, or `null` for one it did
 * not raise — an `ApiError`, which the card renders through `ChangeError`.
 *
 * Each of these is a fixed string plus, at most, the override's name; see the
 * header. `errorMessage` deliberately collapses every non-API error to a
 * generic sentence, which is right for an arbitrary exception and wrong for
 * these, whose messages were written to be read.
 */
export function overrideFailureMessage(cause: unknown): string | null {
  if (
    cause instanceof OverrideNameError ||
    cause instanceof OverrideTooLargeError ||
    cause instanceof OverrideUnreadableError
  ) {
    return cause.message;
  }
  if (cause instanceof Error && cause.name === 'VaultLockedError') {
    return 'Your vault locked before this finished. Unlock it and try again.';
  }
  return null;
}
