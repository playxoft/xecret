'use client';

import {
  computeValueHmac,
  encodePublicKey,
  generateEnvironmentDataKey,
  generateEnvironmentHmacKey,
  openGrant,
  toBase64Url,
  zeroize,
} from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';
import { uuidv7 } from '@xecret/core/ids';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { withVaultKeys } from '@/components/vault/key-store';
import type { VaultKeyMaterial } from '@/components/vault/key-store';
import { fetchEnvironmentKeys, openEnvironmentKeys, sealGrantFor } from './env-keys';
import type { EnvironmentRef } from './env-keys';
import type { EnvKeyMaterial } from './env-key-store';
import { modePinKey, recordModePin } from './pins';
import { decryptNote, decryptValue, encodeNote, encryptValue } from './secret-crypto';
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
 *  3. **Verify**, here, before anything is sent: every value and note opened
 *     again with the functions the read path uses and compared with what was
 *     read, byte for byte, and the grant opened with this vault's private key
 *     to the exact key bytes that sealed them (`verifyUpgradeBody`). The write
 *     that follows deletes the only key that can still read the old values;
 *     a ciphertext nothing opens must be found here, not after it.
 *  4. **Write** `POST …/encryption-upgrade`: one transaction, refused whole if
 *     anything changed in between. A response lost on the way back is settled
 *     by re-reading the environment's key state rather than by guessing.
 *  5. **Share** (the dialog only): the key is re-opened through the ordinary
 *     path — which proves the grant just written opens in this browser — and
 *     sealed to everybody else entitled to it who has a vault (`share.ts`).
 *     Members without one stay queued until they set one up. The automatic
 *     upgrade runs only where nobody else may read the environment, so it has
 *     nobody to share with.
 *
 * ── The one thing refused here that the server could never notice ──
 * Text that is not in Unicode normal form C. Every end-to-end encrypted value
 * and note is NFC-normalised before it is encrypted (`normalizedUtf8`), so that
 * the same text typed on two platforms has one HMAC — and the server envelope
 * never normalised anything. Re-encrypting such text would quietly change its
 * bytes: fatal for a password typed on a keyboard that composed it
 * differently, and for a note somebody pasted one into. So the upgrade stops
 * and names the secret instead of changing anything behind its owner's back.
 */

/** Why a caller cannot upgrade. Mirrors `UpgradeBlocker` in `schemas/encryption-upgrade.ts`. */
export type UpgradeBlocker =
  'already-e2ee' | 'not-a-person' | 'not-permitted' | 'no-vault' | 'token-revoke';

/** What an upgrade would do. Served only to a caller who holds its permissions. */
export interface UpgradeDetails {
  liveSecretCount: number;
  versionCount: number;
  noteCount: number;
  deletedSecrets: { id: string; name: string }[];
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
  /** Everybody else the new key would have to be shared with. */
  otherEntitledCount: number;
}

/** What `GET …/encryption-upgrade` answers. Mirrors `schemas/encryption-upgrade.ts`. */
export interface UpgradePreview {
  encryptionMode: 'server' | 'e2ee';
  environmentId: string;
  canUpgrade: boolean;
  reasons: UpgradeBlocker[];
  details: UpgradeDetails | null;
}

/** What `GET …/encryption-upgrade/material` answers. Plaintext — never logged. */
export interface UpgradeMaterial {
  /** Checked against the organisation this browser resolved, before anything is encrypted. */
  orgId: string;
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
  return `${apiPath.environment(target.orgId, target.projectId, target.envSlug)}/encryption-upgrade`;
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
 * Only when there is nothing to decide and nobody to lose:
 *
 *  - no live secret whose re-encryption someone might want to watch, no CI
 *    token that would stop working, and no deleted secret that would be erased
 *    before its thirty days are up — erasing somebody's deleted secret early is
 *    a decision, however small, and decisions get a dialog;
 *  - **and nobody else who may read the environment.** The new key is born in
 *    this browser and, until it is shared, nobody else holds it. The dialog
 *    shares it straight afterwards; an upgrade nobody asked for does not seal a
 *    key to teammates' server-supplied public keys on their behalf. So where a
 *    teammate would be left with names they can no longer read, it asks.
 *
 * What it leaves is an empty environment only its owner can read — what the
 * seeded `Default` projects of the early sign-ups are — and those become
 * end-to-end encrypted the first time that owner opens one. And only for
 * somebody who may: the server's own answer (`canUpgrade`), with an unlocked
 * vault in this tab.
 */
export function autoUpgradeEligible(preview: UpgradePreview, vaultUnlocked: boolean): boolean {
  const details = preview.details;
  return (
    vaultUnlocked &&
    preview.encryptionMode === 'server' &&
    preview.canUpgrade &&
    details !== null &&
    details.liveSecretCount === 0 &&
    details.versionCount === 0 &&
    details.keylessTokens.length === 0 &&
    details.deletedSecrets.length === 0 &&
    details.otherEntitledCount === 0
  );
}

/**
 * The upgrade cannot go ahead as things stand, for a reason a person can act on.
 *
 * Distinct from a failed request because the fix is not "try again": it is a
 * value to rewrite, or a dialog to read again.
 */
export type UpgradeRefusal =
  | 'not-normalised'
  | 'changed-since-preview'
  | 'no-longer-empty'
  | 'wrong-organisation'
  | 'verification-failed'
  | 'upgraded-elsewhere'
  | 'unconfirmed';

export class UpgradeRefusedError extends Error {
  constructor(
    readonly reason: UpgradeRefusal,
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
    `${names.join(', ')} ${names.length === 1 ? 'holds' : 'hold'} a value or a note in text ` +
    'that end-to-end encryption stores in Unicode normal form, which would change its bytes. ' +
    'Nothing was changed. Rewrite the note, or write a new value (delete and recreate the secret ' +
    'if an older version is the one affected), then upgrade.',
  'changed-since-preview': () =>
    'The deleted secrets or the CI tokens of this environment changed since this dialog opened. ' +
    'Nothing was changed. Close it and open it again to see what the upgrade will do now.',
  'no-longer-empty': () =>
    'This environment is no longer empty, so it is not upgraded without asking. Nothing was changed.',
  'wrong-organisation': () =>
    'The server answered for an environment of another organisation. Nothing was encrypted and ' +
    'nothing was changed. Reload the page and try again.',
  'verification-failed': (names) =>
    `Re-encrypting ${names.length > 0 ? names.join(', ') : 'this environment'} did not check out ` +
    'in this browser: a value would not have opened again. Nothing was sent and nothing was ' +
    'changed. Reload and try again; if it happens twice, contact support.',
  'upgraded-elsewhere': () =>
    'This environment was upgraded to end-to-end encryption by another request while this one ' +
    'was in flight. Reload the page to use it.',
  unconfirmed: () =>
    'The upgrade was sent, and its answer was lost or was a server error, so it is not known ' +
    'whether it landed. Reload the page in a minute: the environment will say whether it is ' +
    'end-to-end encrypted. Do not start it again until you have.',
};

/** Whether a refusal is known to have left the environment exactly as it was. */
export function nothingChanged(error: unknown): boolean {
  return !(error instanceof UpgradeRefusedError && error.reason === 'unconfirmed');
}

/** The secrets with a version value, or a note, whose bytes NFC normalisation would change. */
export function notNormalisedSecrets(material: UpgradeMaterial): string[] {
  const unstable = (text: string) => text.normalize('NFC') !== text;
  return material.secrets
    .filter(
      (secret) =>
        secret.versions.some((version) => unstable(version.value)) ||
        (secret.note !== null && unstable(secret.note)),
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
  // The organisation is the first component of every AAD below. A material
  // read answered for an environment of another organisation would otherwise
  // be re-encrypted, faithfully, for the wrong one.
  if (params.material.orgId !== params.orgId) throw new UpgradeRefusedError('wrong-organisation');

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

  const body: UpgradeBody = {
    envDataKeyId: params.keys.envDataKeyId,
    keys: { grant },
    secrets,
    eraseSecretIds: params.material.deletedSecrets.map((secret) => secret.id),
    revokeTokenIds: params.material.keylessTokens.map((token) => token.id),
  };

  await verifyUpgradeBody({ ...params, body });
  return body;
}

/**
 * Opens everything an upgrade body carries and checks it is exactly what was
 * read — or throws `UpgradeRefusedError('verification-failed')`, and nothing is
 * sent.
 *
 * ── Why the browser checks its own work ──
 * The write this body feeds deletes the only key that can still open the old
 * values. A ciphertext that does not open under the new key, for the row and
 * version it will occupy, is a value nobody can ever read again — and the
 * server cannot tell, because it holds no key. So before anything leaves, each
 * value is decrypted with `decryptValue` and each note with `decryptNote` —
 * the functions the end-to-end encrypted read path itself uses — under the AAD
 * of the row it is filed under, and compared byte for byte with the plaintext
 * the material read returned; and the first grant is opened with this vault's
 * own private key and compared with the key bytes that sealed it all.
 *
 * Exported so the tests can hand it a body that is wrong in each way it could
 * be wrong, which the builder itself never produces.
 */
export async function verifyUpgradeBody(params: {
  vault: VaultKeyMaterial;
  orgId: string;
  material: UpgradeMaterial;
  keys: { envDataKeyId: string; edk: Bytes; ehk: Bytes };
  body: UpgradeBody;
}): Promise<void> {
  const environmentId = params.material.environmentId;
  const envMaterial: EnvKeyMaterial = {
    environmentId,
    envDataKeyId: params.keys.envDataKeyId,
    edkVersion: 1,
    edk: params.keys.edk,
    ehk: params.keys.ehk,
  };
  const failed = new Set<string>();

  if (params.body.envDataKeyId !== params.keys.envDataKeyId) failed.add('the new key');

  // The first grant: addressed to this vault, sealed to its current public key,
  // and opening — with its private key — to exactly these two keys.
  const grant = params.body.keys.grant;
  let grantOpens = false;
  if (
    grant.recipientKind === 'member' &&
    grant.recipientId === params.vault.userId &&
    grant.recipientPublicKey === encodePublicKey(params.vault.encPublicKey)
  ) {
    try {
      const opened = await openGrant({
        recipient: {
          environmentId,
          edkVersion: 1,
          recipientKind: 'member',
          recipientId: params.vault.userId,
        },
        recipientPrivateKey: params.vault.encPrivateKey,
        grant,
      });
      grantOpens = sameBytes(opened.edk, params.keys.edk) && sameBytes(opened.ehk, params.keys.ehk);
      zeroize(opened.edk);
      zeroize(opened.ehk);
    } catch {
      grantOpens = false;
    }
  }
  if (!grantOpens) failed.add('the new key');

  const sent = new Map(params.body.secrets.map((secret) => [secret.id, secret]));
  if (sent.size !== params.material.secrets.length) failed.add('this environment');

  for (const secret of params.material.secrets) {
    const entry = sent.get(secret.id);
    const target = { orgId: params.orgId, environmentId, secretId: secret.id };
    if (entry === undefined || entry.versions.length !== secret.versions.length) {
      failed.add(secret.name);
      continue;
    }
    const byId = new Map(entry.versions.map((version) => [version.id, version]));

    for (const version of secret.versions) {
      const written = byId.get(version.id);
      if (
        written === undefined ||
        written.version !== version.version ||
        written.value.envDataKeyId !== params.keys.envDataKeyId
      ) {
        failed.add(secret.name);
        continue;
      }
      try {
        const reopened = await decryptValue({
          material: envMaterial,
          target,
          version: written.version,
          ciphertext: written.value.ciphertext,
        });
        if (!sameText(reopened, version.value)) failed.add(secret.name);
        // The change-detection tag, recomputed from the EHK: a wrong one is not
        // a lost value, but every write afterwards would look like a change —
        // or, worse, a changed value like none.
        const hmac = toBase64Url(
          await computeValueHmac({ ehk: params.keys.ehk, plaintext: version.value }),
        );
        if (hmac !== written.value.valueHmac) failed.add(secret.name);
      } catch {
        failed.add(secret.name);
      }
    }

    // A note in anything but normal form was refused before encrypting, so it
    // reopens as exactly the bytes read; an empty note travels as no note.
    const note = secret.note === null || secret.note.length === 0 ? null : secret.note;
    if (note === null) {
      if (entry.encNote !== null) failed.add(secret.name);
      continue;
    }
    if (entry.encNote === null) {
      failed.add(secret.name);
      continue;
    }
    try {
      const reopened = await decryptNote({ material: envMaterial, target, blob: entry.encNote });
      if (!sameText(reopened, note)) failed.add(secret.name);
    } catch {
      failed.add(secret.name);
    }
  }

  if (failed.size > 0) throw new UpgradeRefusedError('verification-failed', [...failed]);
}

/** Byte-for-byte, over the UTF-8 encodings. */
function sameText(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return sameBytes(encoder.encode(a), encoder.encode(b));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export type UpgradeStep = 'reading' | 'encrypting' | 'writing' | 'sharing';

export type UpgradeOutcome =
  | {
      status: 'upgraded';
      result: UpgradeResult;
      /** `null` when sharing was not asked for — the automatic upgrade. */
      shared: ShareOutcome | { status: 'failed'; error: unknown } | null;
      /**
       * `true` when the answer to the write was lost and the upgrade was
       * confirmed by re-reading the key state instead. `result` then carries
       * what was sent, not what the server counted.
       */
      confirmedByKeyState?: true;
    }
  /**
   * The upgrade did not land — or, for `UpgradeRefusedError('unconfirmed')`, it
   * is not known whether it did: see `nothingChanged`.
   */
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
  /** `false` for the automatic upgrade: nobody else may read the environment, and nobody asked. */
  share: boolean;
  /** The automatic upgrade refuses anything that is not still empty. */
  automatic?: boolean;
  onProgress?: (step: UpgradeStep) => void;
  /** How long to wait before asking the key state a second time. Tests pass 0. */
  confirmDelayMs?: number;
}): Promise<UpgradeOutcome> {
  let result: UpgradeResult;
  let confirmedByKeyState = false;
  try {
    const details = params.preview.details;
    if (details === null) throw new UpgradeRefusedError('changed-since-preview');

    params.onProgress?.('reading');
    const { material } = await api.get<{ material: UpgradeMaterial }>(
      upgradeMaterialPath(params.target),
    );

    if (
      material.environmentId !== params.preview.environmentId ||
      !sameIds(material.deletedSecrets, details.deletedSecrets) ||
      !sameIds(material.keylessTokens, details.keylessTokens)
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
      // Leased on the vault store for the whole build and its verification: a
      // lock arriving midway waits for it rather than wiping the signing key
      // between two seals or the private key before the grant is reopened.
      const body = await withVaultKeys(params.vault, () =>
        buildUpgradeBody({ vault: params.vault, orgId: params.orgId, material, keys }),
      );

      params.onProgress?.('writing');
      try {
        const response = await api.post<{ upgraded: UpgradeResult }>(
          upgradePath(params.target),
          body,
        );
        result = response.upgraded;
      } catch (error) {
        // A 4xx is the server's answer: it refused, and nothing committed.
        // Anything else — the connection dropped, a gateway answered for a
        // Worker that may already have committed — leaves the question open,
        // and "nothing changed" would be a guess. The key state settles it.
        if (!answerLost(error)) throw error;
        result = await confirmFromKeyState(params.target, body, params.confirmDelayMs ?? 1500);
        confirmedByKeyState = true;
      }
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
  const landed = confirmedByKeyState ? ({ confirmedByKeyState: true } as const) : {};

  if (!params.share) return { status: 'upgraded', result, shared: null, ...landed };

  params.onProgress?.('sharing');
  try {
    const keys = await fetchEnvironmentKeys(params.target);
    const opened = await openEnvironmentKeys(keys, params.vault);
    if (opened.status !== 'open') {
      return {
        status: 'upgraded',
        result,
        shared: { status: 'failed', error: new Error('The new key did not open in this browser.') },
        ...landed,
      };
    }
    const shared = await shareWithMissingRecipients({
      target: params.target,
      vault: params.vault,
      material: opened.material,
    });
    return { status: 'upgraded', result, shared, ...landed };
  } catch (error) {
    return { status: 'upgraded', result, shared: { status: 'failed', error }, ...landed };
  }
}

/** Whether a failed write may still have committed: anything but the server's own 4xx. */
function answerLost(error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500);
}

/**
 * Settles a write whose answer was lost — the connection dropped, or a 5xx
 * arrived from a Worker or a gateway that may already have committed — from the
 * environment's key state.
 *
 * End-to-end encrypted under **the key this request created** means it landed;
 * the counts are then the ones sent, which the transaction accepted whole or not
 * at all. End-to-end encrypted under another key means somebody else's upgrade
 * won. Still `server`-mode is asked once more after a pause, because a commit
 * can trail the error that reported it — and if it still says `server`, the
 * answer is "not known", never "nothing changed": a transaction this browser
 * cannot see is not one it may call rolled back.
 */
async function confirmFromKeyState(
  target: EnvironmentRef,
  body: UpgradeBody,
  delayMs: number,
): Promise<UpgradeResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    let keys: Awaited<ReturnType<typeof fetchEnvironmentKeys>>;
    try {
      keys = await fetchEnvironmentKeys(target);
    } catch {
      throw new UpgradeRefusedError('unconfirmed');
    }
    if (keys.encryptionMode !== 'e2ee') continue;
    if (keys.activeEdk === null || keys.activeEdk.id !== body.envDataKeyId) {
      throw new UpgradeRefusedError('upgraded-elsewhere');
    }

    return {
      activeEdk: keys.activeEdk,
      secretCount: body.secrets.length,
      versionCount: body.secrets.reduce((total, secret) => total + secret.versions.length, 0),
      noteCount: body.secrets.filter((secret) => secret.encNote !== null).length,
      erasedSecretCount: body.eraseSecretIds.length,
      revokedTokenCount: body.revokeTokenIds.length,
    };
  }
  throw new UpgradeRefusedError('unconfirmed');
}

function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((entry) => entry.id));
  return b.every((entry) => ids.has(entry.id));
}
