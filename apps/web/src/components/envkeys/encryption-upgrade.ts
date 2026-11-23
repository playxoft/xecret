'use client';

import {
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  zeroize,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';
import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { withVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { fetchEnvironmentKeys, openEnvironmentKeys, sealGrantFor } from './env-keys';
import type { EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { modePinKey, recordModePin } from './pins';
import { encodeNote, encryptValue } from './secret-crypto';
import { shareWithMissingRecipients } from './share';
import type { ShareOutcome } from './share';
import type { ClientValueBody, GrantBody } from './types';

/**
 * Upgrading a `server`-mode environment to end-to-end encryption, from the
 * browser that does it (ADR 0009, Phase 5).
 *
 * ── What happens, in order ──
 *  1. **Read** `GET …/encryption-upgrade/material`: every version of every live
 *     secret, in plaintext, and every note — the last thing the server ever
 *     decrypts for this environment.
 *  2. **Encrypt**, here: a new data key and HMAC key generated in this browser,
 *     the upgrader's own grant sealed and signed exactly as environment
 *     creation does it (`sealGrantFor`), and every value and note encrypted
 *     exactly as the ordinary write path does it (`encryptValue`,
 *     `encodeNote`) — for the secret id and the version number the value
 *     *already has*, because the rows are rewritten in place and the AAD binds
 *     both.
 *  3. **Write** `POST …/encryption-upgrade`: one transaction, refused whole if
 *     anything changed in between.
 *  4. **Share**: the key is re-opened through the ordinary path — which proves
 *     the grant just written opens in this browser — and sealed to everybody
 *     else entitled to it who has a vault (`share.ts`). Members without one stay
 *     queued until they set one up.
 *
 * ── The one thing refused here that the server could never notice ──
 * A value that is not in Unicode normal form C. Every end-to-end encrypted
 * value is NFC-normalised before it is encrypted (`normalizedUtf8`), so that the
 * same value typed on two platforms has one HMAC — and the server envelope
 * never normalised anything. Re-encrypting such a value would quietly change
 * its bytes: harmless for a label, fatal for a password typed on a keyboard
 * that composed it differently. So the upgrade stops and names the secret
 * instead of changing a credential behind its owner's back. Notes are labels
 * and are normalised like every other note.
 */

/** What `GET …/encryption-upgrade` answers. Mirrors `schemas/encryption-upgrade.ts`. */
export interface UpgradePreview {
  encryptionMode: 'server';
  environmentId: string;
  liveSecretCount: number;
  versionCount: number;
  noteCount: number;
  deletedSecrets: { id: string; name: string }[];
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
  mayUpgrade: boolean;
  blockedBy: 'no-vault' | 'token-revoke' | null;
}

/** What `GET …/encryption-upgrade/material` answers. Plaintext — never logged. */
export interface UpgradeMaterial {
  environmentId: string;
  secrets: {
    id: string;
    name: string;
    valueType: string;
    note: string | null;
    revision: string;
    versions: { id: string; version: number; value: string }[];
  }[];
  deletedSecrets: { id: string; name: string }[];
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
}

/** The body `POST …/encryption-upgrade` takes. */
export interface UpgradeBody {
  envDataKeyId: string;
  keys: { grant: GrantBody };
  secrets: {
    id: string;
    revision: string;
    encNote: string | null;
    versions: { id: string; version: number; value: ClientValueBody }[];
  }[];
  eraseSecretIds: string[];
  revokeTokenIds: string[];
}

export interface UpgradeResult {
  activeEdk: { id: string; version: number };
  secretCount: number;
  versionCount: number;
  noteCount: number;
  erasedSecretCount: number;
  revokedTokenCount: number;
}

export function upgradePath(target: EnvironmentRef): string {
  return `${apiPath.environment(target.orgSlug, target.projectSlug, target.envSlug)}/encryption-upgrade`;
}

export function upgradeMaterialPath(target: EnvironmentRef): string {
  return `${upgradePath(target)}/material`;
}

export async function fetchUpgradePreview(
  target: EnvironmentRef,
  options?: { signal?: AbortSignal },
): Promise<UpgradePreview> {
  const response = await api.get<{ upgrade: UpgradePreview }>(upgradePath(target), options);
  return response.upgrade;
}

/**
 * Whether this environment can be upgraded **without asking anybody**.
 *
 * Only when there is nothing to decide: no live secret whose re-encryption
 * someone might want to watch, no CI token that would stop working, and no
 * deleted secret that would be erased before its thirty days are up. The last
 * condition is stricter than "nothing to re-encrypt" on purpose — erasing
 * somebody's deleted secret early is a decision, however small, and decisions
 * get a dialog. What it leaves is an empty environment, which is what the
 * seeded `Default` projects of the early sign-ups are, and those become end-to-end
 * encrypted the first time a member who may upgrade them opens one.
 *
 * And only for somebody who may: the server's own answer (`mayUpgrade`), with
 * an unlocked vault in this tab.
 */
export function autoUpgradeEligible(preview: UpgradePreview, vaultUnlocked: boolean): boolean {
  return (
    vaultUnlocked &&
    preview.encryptionMode === 'server' &&
    preview.mayUpgrade &&
    preview.liveSecretCount === 0 &&
    preview.versionCount === 0 &&
    preview.keylessTokens.length === 0 &&
    preview.deletedSecrets.length === 0
  );
}

/**
 * The upgrade cannot go ahead as things stand, for a reason a person can act on.
 *
 * Distinct from a failed request because the fix is not "try again": it is a
 * value to rewrite, or a dialog to read again.
 */
export class UpgradeRefusedError extends Error {
  constructor(
    readonly reason: 'not-normalised' | 'changed-since-preview' | 'no-longer-empty',
    readonly secretNames: readonly string[] = [],
  ) {
    super(UPGRADE_REFUSALS[reason](secretNames));
    this.name = 'UpgradeRefusedError';
  }
}

const UPGRADE_REFUSALS: Record<
  UpgradeRefusedError['reason'],
  (names: readonly string[]) => string
> = {
  'not-normalised': (names) =>
    `${names.join(', ')} ${names.length === 1 ? 'holds' : 'hold'} text that end-to-end ` +
    'encryption stores in Unicode normal form, which would change the bytes of the value. ' +
    'Nothing was changed. Write a new value for each (delete and recreate the secret if an older ' +
    'version is the one affected), then upgrade.',
  'changed-since-preview': () =>
    'The deleted secrets or the CI tokens of this environment changed since this dialog opened. ' +
    'Nothing was changed. Close it and open it again to see what the upgrade will do now.',
  'no-longer-empty': () =>
    'This environment is no longer empty, so it is not upgraded without asking. Nothing was changed.',
};

/** The secrets with a version whose value NFC normalisation would change. */
export function notNormalisedSecrets(material: UpgradeMaterial): string[] {
  return material.secrets
    .filter((secret) =>
      secret.versions.some((version) => version.value.normalize('NFC') !== version.value),
    )
    .map((secret) => secret.name);
}

/**
 * The upgrade request: the new key's first grant, and every value and note of
 * the environment re-encrypted for the row and version it already occupies.
 *
 * Pure but for the cryptography, and built from exactly the functions every
 * other end-to-end encrypted write uses — `sealGrantFor` for the grant (as
 * `createEnvironmentKeys` does) and `encryptValue` / `encodeNote` for the
 * values (as `clientSecretIo` does) — so a value written by an upgrade is
 * byte-for-byte the kind of row a value written yesterday in a new environment
 * is. Nothing here generates a key: the caller owns the key bytes and their
 * wiping.
 *
 * `eraseSecretIds` and `revokeTokenIds` are the lists the material read
 * returned, which the caller has already compared against what the person was
 * shown.
 */
export async function buildUpgradeBody(params: {
  vault: VaultKeyMaterial;
  orgId: string;
  material: UpgradeMaterial;
  keys: { envDataKeyId: string; edk: Bytes; ehk: Bytes };
}): Promise<UpgradeBody> {
  const unstable = notNormalisedSecrets(params.material);
  if (unstable.length > 0) throw new UpgradeRefusedError('not-normalised', unstable);

  const environmentId = params.material.environmentId;
  const envMaterial: EnvKeyMaterial = {
    environmentId,
    envDataKeyId: params.keys.envDataKeyId,
    edkVersion: 1,
    edk: params.keys.edk,
    ehk: params.keys.ehk,
  };

  // Version 1, sealed to the upgrader's own public key and signed by them —
  // the first grant of every environment, whichever way it came to exist.
  const grant = await sealGrantFor({
    vault: params.vault,
    environmentId,
    edkVersion: 1,
    edk: params.keys.edk,
    ehk: params.keys.ehk,
    recipientKind: 'member',
    recipientId: params.vault.userId,
    recipientPublicKey: params.vault.encPublicKey,
  });

  const secrets: UpgradeBody['secrets'] = [];
  for (const secret of params.material.secrets) {
    const target = { orgId: params.orgId, environmentId, secretId: secret.id };

    const versions: UpgradeBody['secrets'][number]['versions'] = [];
    for (const version of secret.versions) {
      versions.push({
        id: version.id,
        version: version.version,
        // The version the row already holds, not "the next one": the row is
        // rewritten in place, and the AAD binds the number it is stored under.
        value: await encryptValue({
          material: envMaterial,
          target,
          version: version.version,
          plaintext: version.value,
        }),
      });
    }

    secrets.push({
      id: secret.id,
      revision: secret.revision,
      encNote: (await encodeNote({ material: envMaterial, target, note: secret.note })) ?? null,
      versions,
    });
  }

  return {
    envDataKeyId: params.keys.envDataKeyId,
    keys: { grant },
    secrets,
    eraseSecretIds: params.material.deletedSecrets.map((secret) => secret.id),
    revokeTokenIds: params.material.keylessTokens.map((token) => token.id),
  };
}

export type UpgradeStep = 'reading' | 'encrypting' | 'writing' | 'sharing';

export type UpgradeOutcome =
  | {
      status: 'upgraded';
      result: UpgradeResult;
      /** `null` when sharing was not asked for — the automatic upgrade. */
      shared: ShareOutcome | { status: 'failed'; error: unknown } | null;
    }
  /** Nothing was changed: the write is one transaction, and it did not commit. */
  | { status: 'failed'; error: unknown };

/**
 * Runs the whole upgrade for one environment. See the header for the steps.
 *
 * `preview` is what the person was shown — or, for the automatic upgrade, what
 * made the environment eligible — and the run refuses if the material read says
 * otherwise about the things a person agrees to: which deleted secrets are
 * erased, which tokens are revoked, and (automatically) that there is nothing
 * to re-encrypt. The server then checks the same lists against the database,
 * under its locks, so neither check can be skipped by the other going stale.
 *
 * The generated key bytes are wiped on every exit. The new key is re-opened
 * afterwards through `GET …/keys` and the ordinary grant path, so there is one
 * way key material enters this tab's store.
 */
export async function runEncryptionUpgrade(params: {
  target: EnvironmentRef;
  orgId: string;
  vault: VaultKeyMaterial;
  preview: UpgradePreview;
  /** `false` for the automatic upgrade: an empty environment, and nobody asked. */
  share: boolean;
  /** The automatic upgrade refuses anything that is not still empty. */
  automatic?: boolean;
  onProgress?: (step: UpgradeStep) => void;
}): Promise<UpgradeOutcome> {
  let result: UpgradeResult;
  try {
    params.onProgress?.('reading');
    const { material } = await api.get<{ material: UpgradeMaterial }>(
      upgradeMaterialPath(params.target),
    );

    if (
      !sameIds(material.deletedSecrets, params.preview.deletedSecrets) ||
      !sameIds(material.keylessTokens, params.preview.keylessTokens)
    ) {
      throw new UpgradeRefusedError('changed-since-preview');
    }
    if (params.automatic === true && material.secrets.length > 0) {
      throw new UpgradeRefusedError('no-longer-empty');
    }

    params.onProgress?.('encrypting');
    const keys = {
      envDataKeyId: uuidv7(),
      edk: generateEnvironmentDataKey(),
      ehk: generateEnvironmentHmacKey(),
    };

    try {
      // Leased on the vault store for the whole build: a lock arriving midway
      // waits for it rather than wiping the signing key between two seals.
      const body = await withVaultKeys(params.vault, () =>
        buildUpgradeBody({ vault: params.vault, orgId: params.orgId, material, keys }),
      );

      params.onProgress?.('writing');
      const response = await api.post<{ upgraded: UpgradeResult }>(
        upgradePath(params.target),
        body,
      );
      result = response.upgraded;
    } finally {
      zeroize(keys.edk);
      zeroize(keys.ehk);
    }
  } catch (error) {
    return { status: 'failed', error };
  }

  // The environment is end-to-end encrypted from here on, and this browser has
  // seen it say so: a later `server` answer for it is refused (`pins.ts`).
  recordModePin(modePinKey(params.target), 'e2ee');

  if (!params.share) return { status: 'upgraded', result, shared: null };

  params.onProgress?.('sharing');
  try {
    const keys = await fetchEnvironmentKeys(params.target);
    const opened = await openEnvironmentKeys(keys, params.vault);
    if (opened.status !== 'open') {
      return {
        status: 'upgraded',
        result,
        shared: { status: 'failed', error: new Error('The new key did not open in this browser.') },
      };
    }
    const shared = await shareWithMissingRecipients({
      target: params.target,
      vault: params.vault,
      material: opened.material,
    });
    return { status: 'upgraded', result, shared };
  } catch (error) {
    return { status: 'upgraded', result, shared: { status: 'failed', error } };
  }
}

function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((entry) => entry.id));
  return b.every((entry) => ids.has(entry.id));
}
