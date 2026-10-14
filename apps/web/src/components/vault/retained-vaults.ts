'use client';

import {
  derivePassphraseWrapKey,
  deriveRecoveryKey,
  deriveStretchedKey,
  deriveUkUnlockVerifier,
  fromBase64Url,
  openGrant,
  recoveryLookupHash,
  toBase64Url,
  unwrapPrivateKey,
  unwrapUserKey,
  zeroize,
} from '@xecret/core/crypto/client';
import type { Argon2idProvider, Bytes, RecoveryCode } from '@xecret/core/crypto/client';

import { api } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { sealGrantFor } from '@/components/envkeys/env-keys';
import { argon2idProvider } from './argon2';
import { withVaultKeys } from './key-store';
import type { VaultKeyMaterial } from './key-store';

/**
 * Recovering a reset vault, in the browser (P23).
 *
 * A reset keeps the old vault for seven days. This is what brings it back — not
 * as the account's vault again, but *into* the vault the person set up after
 * the reset: the old one is opened here with its passphrase or one of its
 * recovery codes, each environment key it held is opened with its private key,
 * re-sealed to the current vault's public key, signed with the current vault's
 * signing key, and posted. The server writes them as ordinary grants and never
 * sees a key, the passphrase, or the code.
 *
 * So the account keeps one working key hierarchy — its current one — and
 * nothing sealed to it is touched: a key a teammate re-shared during the window
 * is the same key, and the server skips it.
 *
 * Every key opened here is zeroised before the function returns, on every path.
 *
 * A grant that does not open with the old private key — damaged, or sealed to
 * something else — is skipped and reported, like the archive reader's "no
 * key": one bad row must not keep every other environment from coming back.
 */

const path = {
  list: () => '/api/auth/vault/retained',
  one: (id: string) => `/api/auth/vault/retained/${encodeURIComponent(id)}`,
  recoveryWrap: (id: string) => `/api/auth/vault/retained/${encodeURIComponent(id)}/recovery-wrap`,
  restore: (id: string) => `/api/auth/vault/retained/${encodeURIComponent(id)}/restore`,
};

export interface RetainedVault {
  id: string;
  retainedAt: string;
  retainedUntil: string;
  recoveredAt: string | null;
  /** Key versions held. */
  grantCount: number;
  /** The environments they open: what the screens count. */
  environmentCount: number;
  recoveryCodesRemaining: number;
}

export interface RetainedGrant {
  envDataKeyId: string;
  edkVersion: number;
  edkStatus: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isProduction: boolean;
  projectName: string;
  projectSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  edkSealed: string;
  ehkSealed: string;
}

export interface RetainedVaultMaterial extends RetainedVault {
  userId: string;
  encPublicKey: string;
  encPrivateKeyEnc: string;
  kdfSalt: string;
  kdfParams: unknown;
  passphraseWrap: string;
  grants: RetainedGrant[];
}

export type RetainedCredential =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery-code'; code: RecoveryCode };

export type RestoreSkipReason = 'no-access' | 'already-held' | 'environment-gone';

/** What the server answers: per key version. */
export interface RestoreOutcome {
  restored: number;
  skipped: { envDataKeyId: string; reason: RestoreSkipReason }[];
}

/** Why an environment got nothing back. `did-not-open` is decided here, before any request. */
export type RecoverySkipReason = RestoreSkipReason | 'did-not-open';

/** What a recovery did, per environment — what a person counts. */
export interface RecoveryReport {
  /** Environments with at least one key brought back. */
  restoredEnvironments: number;
  /** Each environment that got nothing back, once, with the reason. */
  skipped: { environmentId: string; reason: RecoverySkipReason }[];
}

export interface RestoredGrantBody {
  envDataKeyId: string;
  recipientPublicKey: string;
  edkSealed: string;
  ehkSealed: string;
  signature: string;
}

export async function listRetainedVaults(): Promise<RetainedVault[]> {
  return (await api.get<{ retained: RetainedVault[] }>(path.list())).retained;
}

export async function fetchRetainedVault(id: string): Promise<RetainedVaultMaterial> {
  return (await api.get<{ retained: RetainedVaultMaterial }>(path.one(id))).retained;
}

/**
 * Opens the retained vault's User Key with its passphrase, or with one of its
 * recovery codes — whose wrap is fetched by lookup hash, one at a time, as the
 * live vault's are.
 *
 * Throws `DecryptionError` when the credential does not open it.
 */
export async function openRetainedUserKey(params: {
  material: RetainedVaultMaterial;
  credential: RetainedCredential;
  argon2id?: Argon2idProvider;
  /** Fetches the wrap for a lookup hash. Defaults to the API; a test supplies its own. */
  recoveryWrap?: (lookupHash: Bytes) => Promise<string>;
}): Promise<Bytes> {
  const { material, credential } = params;
  const userId = material.userId;

  if (credential.kind === 'passphrase') {
    const stretched = await deriveStretchedKey({
      passphrase: credential.passphrase,
      salt: fromBase64Url(material.kdfSalt),
      params: material.kdfParams,
      argon2id: params.argon2id ?? argon2idProvider,
    });
    const wrapKey = await derivePassphraseWrapKey(stretched);
    zeroize(stretched);
    try {
      return await unwrapUserKey({
        wrapKey,
        blob: material.passphraseWrap,
        context: { userId, wrapKind: 'passphrase' },
      });
    } finally {
      zeroize(wrapKey);
    }
  }

  const lookupHash = await recoveryLookupHash(credential.code.codeBytes);
  const wrap = await (
    params.recoveryWrap ??
    (async (hash: Bytes) =>
      (
        await api.post<{ wrap: string }>(path.recoveryWrap(material.id), {
          lookupHash: toBase64Url(hash),
        })
      ).wrap)
  )(lookupHash);

  const recoveryKey = await deriveRecoveryKey(credential.code.codeBytes);
  try {
    return await unwrapUserKey({
      wrapKey: recoveryKey,
      blob: wrap,
      context: { userId, wrapKind: 'recovery', lookupHash },
    });
  } finally {
    zeroize(recoveryKey);
  }
}

/**
 * Re-seals every key the retained vault held to the current vault, and derives
 * the proof that its User Key was opened. Pure but for the crypto: no network.
 *
 * Consumes `oldUserKey` — it is zeroised before this returns.
 */
export async function buildRestore(params: {
  material: RetainedVaultMaterial;
  oldUserKey: Bytes;
  current: VaultKeyMaterial;
}): Promise<{ ukUnlockVerifier: string; grants: RestoredGrantBody[]; unopened: string[] }> {
  const { material, current } = params;
  let oldPrivateKey: Bytes | null = null;

  try {
    const ukUnlockVerifier = toBase64Url(await deriveUkUnlockVerifier(params.oldUserKey));
    oldPrivateKey = await unwrapPrivateKey({
      userKey: params.oldUserKey,
      blob: material.encPrivateKeyEnc,
      userId: material.userId,
      purpose: 'encryption',
    });

    const grants: RestoredGrantBody[] = [];
    const unopened: string[] = [];
    for (const grant of material.grants) {
      let opened: { edk: Bytes; ehk: Bytes };
      try {
        opened = await openGrant({
          recipient: {
            environmentId: grant.environmentId,
            edkVersion: grant.edkVersion,
            recipientKind: 'member',
            recipientId: material.userId,
          },
          recipientPrivateKey: oldPrivateKey,
          grant: { edkSealed: grant.edkSealed, ehkSealed: grant.ehkSealed },
        });
      } catch {
        // Skipped and reported, not fatal: the rest still come back.
        unopened.push(grant.envDataKeyId);
        continue;
      }
      const { edk, ehk } = opened;
      try {
        const sealed = await sealGrantFor({
          vault: current,
          environmentId: grant.environmentId,
          edkVersion: grant.edkVersion,
          edk,
          ehk,
          recipientKind: 'member',
          recipientId: material.userId,
          recipientPublicKey: current.encPublicKey,
        });
        grants.push({
          envDataKeyId: grant.envDataKeyId,
          recipientPublicKey: sealed.recipientPublicKey,
          edkSealed: sealed.edkSealed,
          ehkSealed: sealed.ehkSealed,
          signature: sealed.signature,
        });
      } finally {
        zeroize(edk);
        zeroize(ehk);
      }
    }

    return { ukUnlockVerifier, grants, unopened };
  } finally {
    if (oldPrivateKey !== null) zeroize(oldPrivateKey);
    zeroize(params.oldUserKey);
  }
}

/**
 * The whole recovery: open the old vault, re-seal its keys to the current one,
 * and post them. Leased on the current vault's keys, so a lock that lands
 * mid-way waits for it, and one that landed first refuses it.
 */
export async function recoverRetainedVault(params: {
  id: string;
  credential: RetainedCredential;
  current: VaultKeyMaterial;
  argon2id?: Argon2idProvider;
}): Promise<RecoveryReport> {
  const material = await fetchRetainedVault(params.id);
  if (material.userId !== params.current.userId) {
    // The server scopes every retained vault to its owner; this is the same
    // rule seen from here, so a tab that changed accounts cannot mix two.
    throw new Error('That vault belongs to a different account.');
  }

  const oldUserKey = await openRetainedUserKey({
    material,
    credential: params.credential,
    ...(params.argon2id === undefined ? {} : { argon2id: params.argon2id }),
  });

  try {
    return await withVaultKeys(params.current, async () => {
      const { unopened, ...body } = await buildRestore({
        material,
        oldUserKey,
        current: params.current,
      });
      const outcome = await api.post<RestoreOutcome>(path.restore(params.id), body);
      return reportByEnvironment(material.grants, outcome, unopened);
    });
  } finally {
    // `buildRestore` wipes it; a lock that refused the lease first did not reach it.
    zeroize(oldUserKey);
  }
}

/**
 * The server's answer, per key version, turned into one per environment: an
 * environment is restored when any of its keys came back, and otherwise
 * skipped once, for the most telling of its keys' reasons.
 */
export function reportByEnvironment(
  grants: readonly Pick<RetainedGrant, 'envDataKeyId' | 'environmentId'>[],
  outcome: RestoreOutcome,
  unopened: readonly string[],
): RecoveryReport {
  const reasons = new Map<string, RecoverySkipReason>();
  for (const id of unopened) reasons.set(id, 'did-not-open');
  for (const skip of outcome.skipped) reasons.set(skip.envDataKeyId, skip.reason);

  const byEnvironment = new Map<string, RecoverySkipReason[] | 'restored'>();
  for (const grant of grants) {
    const reason = reasons.get(grant.envDataKeyId);
    const current = byEnvironment.get(grant.environmentId);
    if (reason === undefined) byEnvironment.set(grant.environmentId, 'restored');
    else if (current !== 'restored') {
      byEnvironment.set(grant.environmentId, [...(current ?? []), reason]);
    }
  }

  const skipped: RecoveryReport['skipped'] = [];
  let restoredEnvironments = 0;
  for (const [environmentId, state] of byEnvironment) {
    if (state === 'restored') {
      restoredEnvironments += 1;
      continue;
    }
    const reason = SKIP_PRIORITY.find((candidate) => state.includes(candidate)) ?? state[0]!;
    skipped.push({ environmentId, reason });
  }
  return { restoredEnvironments, skipped };
}

/** Which reason describes an environment whose keys were skipped for several. */
const SKIP_PRIORITY: readonly RecoverySkipReason[] = [
  'did-not-open',
  'no-access',
  'environment-gone',
  'already-held',
];

/** A sentence for each kind of environment a recovery skipped, for the result screen. */
export function describeSkips(skipped: RecoveryReport['skipped']): string[] {
  const counts: Record<RecoverySkipReason, number> = {
    'already-held': 0,
    'no-access': 0,
    'environment-gone': 0,
    'did-not-open': 0,
  };
  for (const skip of skipped) counts[skip.reason] += 1;

  const lines: string[] = [];
  if (counts['already-held'] > 0) {
    lines.push(
      `${pluralize(counts['already-held'], 'environment')} you already had again — a teammate re-shared ${counts['already-held'] === 1 ? 'it' : 'them'}.`,
    );
  }
  if (counts['no-access'] > 0) {
    lines.push(
      `${pluralize(counts['no-access'], 'environment')} you no longer have access to, so not restored.`,
    );
  }
  if (counts['environment-gone'] > 0) {
    lines.push(`${pluralize(counts['environment-gone'], 'environment')} deleted since the reset.`);
  }
  if (counts['did-not-open'] > 0) {
    lines.push(
      `${pluralize(counts['did-not-open'], 'environment')} whose key in the old vault did not open, so not restored.`,
    );
  }
  return lines;
}
