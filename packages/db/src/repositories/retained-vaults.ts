import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Argon2idParams } from '@xecret/core/crypto/client';
import type { UnlockAttemptState } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { envDataKeys, envKeyGrants, pendingKeyGrants } from '../schema/env-keys';
import { environments, projects } from '../schema/resources';
import {
  retainedVaultGrants,
  retainedVaults,
  retainedVaultWraps,
  VAULT_RETENTION_MS,
} from '../schema/retained-vaults';
import { organizations } from '../schema/tenancy';
import { userKeys, userKeyWraps } from '../schema/vault';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Retained vaults: the seven days after a reset (P23).
 *
 * ── The three things this module is responsible for ──
 *
 *  - **A reset retains, in the reset's own transaction.** {@link retainVaultForReset}
 *    copies the key row, the live passphrase wrap, every unused recovery wrap and
 *    every member grant before `resetVault` deletes them. Either the vault is
 *    retained and the live one gone, or neither happened.
 *  - **Nothing reads a vault past its window.** Every query here takes `now` and
 *    filters `purge_after > now`, so a vault the purge has not reached yet is
 *    already unrecoverable at the instant its seven days end. The purge's timing
 *    is housekeeping; this is the control.
 *  - **Nothing deletes a vault inside its window.** There is no function here
 *    that could: the only DELETE is {@link purgeExpiredRetainedVaults}, which
 *    names `purge_after <= now`, and below it migration 0020's triggers refuse
 *    any early delete by the database's own clock, whoever issues it.
 *
 * ── Recovery merges, it does not swap ──
 * {@link restoreRetainedGrants} writes the old vault's environment keys into the
 * account's *current* vault, as new member grants sealed by the browser to the
 * current public key. Nothing sealed to the current vault is touched, so a
 * re-share a teammate made during the window, an environment created since, and
 * every secret written since all stay exactly as they are. The account ends with
 * one working key hierarchy — the current one — holding everything both held.
 */

export interface RetainedVaultSummary {
  id: string;
  retainedAt: Date;
  purgeAfter: Date;
  recoveredAt: Date | null;
  /** Environment-key grants the vault held. */
  grantCount: number;
  /** Unused recovery codes that open it. */
  recoveryCodesRemaining: number;
}

/** One retained grant, with the environment it opens. Only live e2ee environments. */
export interface RetainedGrantRecord {
  envDataKeyId: string;
  edkVersion: number;
  /** `active` or `retired`. Only an active key settles a pending share. */
  edkStatus: string;
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  isProduction: boolean;
  projectId: string;
  projectName: string;
  projectSlug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
}

/** Everything the browser needs to open a retained vault and re-seal its keys. */
export interface RetainedVaultMaterial extends RetainedVaultSummary, UnlockAttemptState {
  userId: string;
  encPublicKey: Uint8Array;
  encPrivateKeyEnc: Uint8Array;
  kdfSalt: Uint8Array;
  kdfParams: Argon2idParams;
  passphraseWrap: Uint8Array;
  ukUnlockVerifierHash: Uint8Array;
  /** Grants whose environment still exists. A deleted one has nothing to restore into. */
  grants: RetainedGrantRecord[];
}

/** What a reset retained. */
export interface RetainedVaultReceipt {
  id: string;
  retainedAt: Date;
  purgeAfter: Date;
  grantCount: number;
}

/**
 * Copies the account's vault into the retained tables, and returns what was
 * retained — or `null` when there is no vault.
 *
 * **Must run inside the reset's transaction, before anything is deleted.** It
 * takes the vault row `FOR UPDATE`, so two resets racing each other serialise
 * here: the second finds no row once the first commits, and retains nothing.
 *
 * Copies only what can open the vault or what it opens: the live passphrase
 * wrap, the unused recovery wraps, and every member grant at every key version.
 * Superseded passphrase wraps and redeemed codes are old credentials of a key
 * being retired, and passkey PRF wraps need an authenticator and the relying
 * party — none of them is kept.
 */
export async function retainVaultForReset(
  tx: Executor,
  userId: string,
  now: Date,
): Promise<RetainedVaultReceipt | null> {
  const [keys] = await tx
    .select()
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1)
    .for('update');

  if (!keys) return null;

  const id = uuidv7();
  const purgeAfter = new Date(now.getTime() + VAULT_RETENTION_MS);

  await tx.insert(retainedVaults).values({
    id,
    userId,
    encAlgorithm: keys.encAlgorithm,
    encPublicKey: keys.encPublicKey,
    encPrivateKeyEnc: keys.encPrivateKeyEnc,
    signAlgorithm: keys.signAlgorithm,
    signPublicKey: keys.signPublicKey,
    signPrivateKeyEnc: keys.signPrivateKeyEnc,
    kdfSalt: keys.kdfSalt,
    kdfParams: keys.kdfParams,
    unlockVerifierHash: keys.unlockVerifierHash,
    ukUnlockVerifierHash: keys.ukUnlockVerifierHash,
    vaultCreatedAt: keys.createdAt,
    vaultRotatedAt: keys.rotatedAt,
    retainedAt: now,
    purgeAfter,
  });

  const wraps = await tx
    .select({
      kind: userKeyWraps.kind,
      wrap: userKeyWraps.wrap,
      lookupHash: userKeyWraps.lookupHash,
      createdAt: userKeyWraps.createdAt,
    })
    .from(userKeyWraps)
    .where(
      and(
        eq(userKeyWraps.userId, userId),
        or(
          and(eq(userKeyWraps.kind, 'passphrase'), isNull(userKeyWraps.supersededAt)),
          and(eq(userKeyWraps.kind, 'recovery'), isNull(userKeyWraps.usedAt)),
        ),
      ),
    );

  if (wraps.length > 0) {
    await tx.insert(retainedVaultWraps).values(
      wraps.map((wrap) => ({
        id: uuidv7(),
        retainedVaultId: id,
        kind: wrap.kind === 'passphrase' ? ('passphrase' as const) : ('recovery' as const),
        wrap: wrap.wrap,
        lookupHash: wrap.lookupHash,
        createdAt: wrap.createdAt,
      })),
    );
  }

  const grants = await tx
    .select({
      envDataKeyId: envKeyGrants.envDataKeyId,
      edkSealed: envKeyGrants.edkSealed,
      ehkSealed: envKeyGrants.ehkSealed,
      recipientPublicKey: envKeyGrants.recipientPublicKey,
      signature: envKeyGrants.signature,
      signedByUserId: envKeyGrants.signedByUserId,
      createdAt: envKeyGrants.createdAt,
    })
    .from(envKeyGrants)
    .where(eq(envKeyGrants.memberUserId, userId));

  if (grants.length > 0) {
    await tx.insert(retainedVaultGrants).values(
      grants.map((grant) => ({
        id: uuidv7(),
        retainedVaultId: id,
        envDataKeyId: grant.envDataKeyId,
        edkSealed: grant.edkSealed,
        ehkSealed: grant.ehkSealed,
        recipientPublicKey: grant.recipientPublicKey,
        signature: grant.signature,
        signedByUserId: grant.signedByUserId,
        grantedAt: grant.createdAt,
      })),
    );
  }

  return { id, retainedAt: now, purgeAfter, grantCount: grants.length };
}

/** The account's retained vaults still inside their window, newest first. */
export async function listRetainedVaults(
  exec: Executor,
  userId: string,
  now: Date,
): Promise<RetainedVaultSummary[]> {
  const vaults = await exec
    .select({
      id: retainedVaults.id,
      retainedAt: retainedVaults.retainedAt,
      purgeAfter: retainedVaults.purgeAfter,
      recoveredAt: retainedVaults.recoveredAt,
    })
    .from(retainedVaults)
    .where(and(eq(retainedVaults.userId, userId), gt(retainedVaults.purgeAfter, now)))
    .orderBy(desc(retainedVaults.retainedAt));

  if (vaults.length === 0) return [];
  const ids = vaults.map((vault) => vault.id);

  const grantCounts = await exec
    .select({ id: retainedVaultGrants.retainedVaultId, total: count() })
    .from(retainedVaultGrants)
    .where(inArray(retainedVaultGrants.retainedVaultId, ids))
    .groupBy(retainedVaultGrants.retainedVaultId);

  const codeCounts = await exec
    .select({ id: retainedVaultWraps.retainedVaultId, total: count() })
    .from(retainedVaultWraps)
    .where(
      and(
        inArray(retainedVaultWraps.retainedVaultId, ids),
        eq(retainedVaultWraps.kind, 'recovery'),
      ),
    )
    .groupBy(retainedVaultWraps.retainedVaultId);

  const grantsBy = new Map(grantCounts.map((row) => [row.id, row.total]));
  const codesBy = new Map(codeCounts.map((row) => [row.id, row.total]));

  return vaults.map((vault) => ({
    ...vault,
    grantCount: grantsBy.get(vault.id) ?? 0,
    recoveryCodesRemaining: codesBy.get(vault.id) ?? 0,
  }));
}

/**
 * One retained vault, whole — scoped to its owner and to its window.
 *
 * The same `null` for "another account's", "never existed" and "past its
 * window", so the id of somebody else's vault is indistinguishable from noise
 * (threat T2), and a vault the purge has not reached yet is already gone.
 */
export async function loadRetainedVault(
  exec: Executor,
  userId: string,
  retainedVaultId: string,
  now: Date,
): Promise<RetainedVaultMaterial | null> {
  const [vault] = await exec
    .select()
    .from(retainedVaults)
    .where(
      and(
        eq(retainedVaults.id, retainedVaultId),
        eq(retainedVaults.userId, userId),
        gt(retainedVaults.purgeAfter, now),
      ),
    )
    .limit(1);

  if (!vault) return null;

  const [passphrase] = await exec
    .select({ wrap: retainedVaultWraps.wrap })
    .from(retainedVaultWraps)
    .where(
      and(
        eq(retainedVaultWraps.retainedVaultId, vault.id),
        eq(retainedVaultWraps.kind, 'passphrase'),
      ),
    )
    .limit(1);

  if (!passphrase) {
    throw new RepositoryError('invalid', 'This retained vault has no passphrase wrap.');
  }

  const [codes] = await exec
    .select({ total: count() })
    .from(retainedVaultWraps)
    .where(
      and(
        eq(retainedVaultWraps.retainedVaultId, vault.id),
        eq(retainedVaultWraps.kind, 'recovery'),
      ),
    );

  const [grantTotal] = await exec
    .select({ total: count() })
    .from(retainedVaultGrants)
    .where(eq(retainedVaultGrants.retainedVaultId, vault.id));

  return {
    id: vault.id,
    userId: vault.userId,
    retainedAt: vault.retainedAt,
    purgeAfter: vault.purgeAfter,
    recoveredAt: vault.recoveredAt,
    grantCount: grantTotal?.total ?? 0,
    recoveryCodesRemaining: codes?.total ?? 0,
    encPublicKey: vault.encPublicKey,
    encPrivateKeyEnc: vault.encPrivateKeyEnc,
    kdfSalt: vault.kdfSalt,
    kdfParams: vault.kdfParams,
    passphraseWrap: passphrase.wrap,
    ukUnlockVerifierHash: vault.ukUnlockVerifierHash,
    failedAttempts: vault.recoveryFailedAttempts,
    lockedUntil: vault.recoveryLockedUntil,
    grants: await retainedGrants(exec, vault.id),
  };
}

/** A retained vault's grants whose environment, project and organisation are all live, and e2ee. */
async function retainedGrants(
  exec: Executor,
  retainedVaultId: string,
): Promise<RetainedGrantRecord[]> {
  return exec
    .select({
      envDataKeyId: retainedVaultGrants.envDataKeyId,
      edkVersion: envDataKeys.version,
      edkStatus: envDataKeys.status,
      environmentId: environments.id,
      environmentName: environments.name,
      environmentSlug: environments.slug,
      isProduction: environments.isProduction,
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      edkSealed: retainedVaultGrants.edkSealed,
      ehkSealed: retainedVaultGrants.ehkSealed,
    })
    .from(retainedVaultGrants)
    .innerJoin(envDataKeys, eq(envDataKeys.id, retainedVaultGrants.envDataKeyId))
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(
      and(
        eq(retainedVaultGrants.retainedVaultId, retainedVaultId),
        eq(environments.encryptionMode, 'e2ee'),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
        isNull(organizations.deletedAt),
      ),
    )
    .orderBy(
      asc(organizations.name),
      asc(projects.name),
      asc(environments.name),
      asc(envDataKeys.version),
    );
}

/**
 * The recovery wrap a presented lookup hash addresses, in one of this account's
 * retained vaults inside its window — or `null`, for every kind of miss alike.
 */
export async function findRetainedRecoveryWrap(
  exec: Executor,
  params: { userId: string; retainedVaultId: string; lookupHash: Uint8Array; now: Date },
): Promise<Uint8Array | null> {
  const [row] = await exec
    .select({ wrap: retainedVaultWraps.wrap })
    .from(retainedVaultWraps)
    .innerJoin(retainedVaults, eq(retainedVaults.id, retainedVaultWraps.retainedVaultId))
    .where(
      and(
        eq(retainedVaultWraps.retainedVaultId, params.retainedVaultId),
        eq(retainedVaultWraps.kind, 'recovery'),
        eq(retainedVaultWraps.lookupHash, params.lookupHash),
        eq(retainedVaults.userId, params.userId),
        gt(retainedVaults.purgeAfter, params.now),
      ),
    )
    .limit(1);

  return row?.wrap ?? null;
}

/** Records the outcome of one recovery proof against a retained vault. */
export async function recordRetainedRecoveryAttempt(
  exec: Executor,
  retainedVaultId: string,
  state: UnlockAttemptState,
): Promise<void> {
  await exec
    .update(retainedVaults)
    .set({ recoveryFailedAttempts: state.failedAttempts, recoveryLockedUntil: state.lockedUntil })
    .where(eq(retainedVaults.id, retainedVaultId));
}

/** One re-sealed grant, as the browser sends it. */
export interface RestoredGrantSeed {
  envDataKeyId: string;
  /** 32 bytes: the current vault's X25519 public key, which the blobs were sealed to. */
  recipientPublicKey: Uint8Array;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
  signature: Uint8Array;
}

export type RestoreSkipReason = 'no-access' | 'already-held' | 'environment-gone';

export interface RestoreResult {
  restored: { envDataKeyId: string; environmentId: string; orgId: string }[];
  skipped: { envDataKeyId: string; reason: RestoreSkipReason }[];
}

/** An environment the restore wants to write into, for the caller's authorisation check. */
export interface RestoreTarget {
  orgId: string;
  projectId: string;
  environmentId: string;
  isProduction: boolean;
}

/**
 * Writes a retained vault's environment keys into the account's current vault,
 * as new member grants, and settles the pending shares they answer — in one
 * transaction, under a lock on the retained vault.
 *
 * ── What it refuses, and why each is a refusal rather than a skip ──
 *  - no current vault (`conflict`): there is nothing to merge into. The browser
 *    sets one up first.
 *  - a grant not sealed to the current vault's public key (`invalid`): the blobs
 *    would open for nobody, and the row would block a teammate's re-share of the
 *    same key version, which the unique index allows only once.
 *  - a key the retained vault never held (`invalid`): this endpoint restores what
 *    the old vault had, not whatever key a client claims to have found.
 *  - a key named twice (`invalid`).
 *  - the retained vault missing, foreign, or past its window (`notFound`).
 *
 * ── What it skips, and reports ──
 *  - `environment-gone` — deleted since, or no longer end-to-end encrypted;
 *  - `no-access` — `authorize` says the account may no longer read it. Losing
 *    access during the window is exactly the case a recovery must not undo;
 *  - `already-held` — the account already holds that key version, typically
 *    because a teammate re-shared it during the window. Same key, nothing to do.
 *
 * `authorize` is a callback for the reason `resetVault`'s `requeue` is one:
 * deciding who may read what needs `can()`, and this layer does not import the
 * policy engine. It runs inside this transaction.
 */
export async function restoreRetainedGrants(
  exec: Executor,
  params: {
    userId: string;
    retainedVaultId: string;
    grants: readonly RestoredGrantSeed[];
    now: Date;
    authorize: (tx: Executor, targets: readonly RestoreTarget[]) => Promise<Set<string>>;
  },
): Promise<RestoreResult> {
  return exec.transaction(async (tx) => {
    const [vault] = await tx
      .select({ id: retainedVaults.id })
      .from(retainedVaults)
      .where(
        and(
          eq(retainedVaults.id, params.retainedVaultId),
          eq(retainedVaults.userId, params.userId),
          gt(retainedVaults.purgeAfter, params.now),
        ),
      )
      .limit(1)
      .for('update');

    if (!vault) throw new RepositoryError('notFound', 'No such retained vault.');

    const [current] = await tx
      .select({ encPublicKey: userKeys.encPublicKey })
      .from(userKeys)
      .where(eq(userKeys.userId, params.userId))
      .limit(1)
      .for('share');

    if (!current) {
      throw new RepositoryError('conflict', 'Set up a vault before recovering an old one into it.');
    }

    const seen = new Set<string>();
    for (const grant of params.grants) {
      if (seen.has(grant.envDataKeyId)) {
        throw new RepositoryError('invalid', 'The same key was submitted twice.');
      }
      seen.add(grant.envDataKeyId);
      if (!bytesEqual(grant.recipientPublicKey, current.encPublicKey)) {
        throw new RepositoryError(
          'invalid',
          "A grant is not sealed to this account's current vault.",
        );
      }
    }

    const held = await tx
      .select({ envDataKeyId: retainedVaultGrants.envDataKeyId })
      .from(retainedVaultGrants)
      .where(eq(retainedVaultGrants.retainedVaultId, vault.id));
    const heldIds = new Set(held.map((row) => row.envDataKeyId));
    for (const grant of params.grants) {
      if (!heldIds.has(grant.envDataKeyId)) {
        throw new RepositoryError('invalid', 'A grant names a key the retained vault never held.');
      }
    }

    const live = new Map(
      (await retainedGrants(tx, vault.id)).map((grant) => [grant.envDataKeyId, grant]),
    );
    const targets = new Map<string, RestoreTarget>();
    for (const grant of live.values()) {
      targets.set(grant.environmentId, {
        orgId: grant.orgId,
        projectId: grant.projectId,
        environmentId: grant.environmentId,
        isProduction: grant.isProduction,
      });
    }
    const allowed =
      targets.size === 0 ? new Set<string>() : await params.authorize(tx, [...targets.values()]);

    const result: RestoreResult = { restored: [], skipped: [] };

    for (const grant of params.grants) {
      const target = live.get(grant.envDataKeyId);
      if (target === undefined) {
        result.skipped.push({ envDataKeyId: grant.envDataKeyId, reason: 'environment-gone' });
        continue;
      }
      if (!allowed.has(target.environmentId)) {
        result.skipped.push({ envDataKeyId: grant.envDataKeyId, reason: 'no-access' });
        continue;
      }

      // ON CONFLICT DO NOTHING against `env_key_grants_member_unique`: a grant
      // for this key version already held — a teammate re-shared it during the
      // window — is the same key, and there is nothing to add.
      const inserted = await tx
        .insert(envKeyGrants)
        .values({
          id: uuidv7(),
          envDataKeyId: grant.envDataKeyId,
          memberUserId: params.userId,
          edkSealed: grant.edkSealed,
          ehkSealed: grant.ehkSealed,
          recipientPublicKey: grant.recipientPublicKey,
          signature: grant.signature,
          signedByUserId: params.userId,
          createdAt: params.now,
        })
        .onConflictDoNothing()
        .returning({ id: envKeyGrants.id });

      if (inserted.length === 0) {
        result.skipped.push({ envDataKeyId: grant.envDataKeyId, reason: 'already-held' });
        continue;
      }

      // Only the active key answers a pending share: a grant on a retired
      // version reads history and nothing written since, which is precisely the
      // state a pending share exists to resolve rather than to hide.
      if (target.edkStatus === 'active') {
        await tx
          .delete(pendingKeyGrants)
          .where(
            and(
              eq(pendingKeyGrants.environmentId, target.environmentId),
              eq(pendingKeyGrants.targetUserId, params.userId),
            ),
          );
      }

      result.restored.push({
        envDataKeyId: grant.envDataKeyId,
        environmentId: target.environmentId,
        orgId: target.orgId,
      });
    }

    await tx
      .update(retainedVaults)
      .set({ recoveredAt: params.now, recoveryFailedAttempts: 0, recoveryLockedUntil: null })
      .where(eq(retainedVaults.id, vault.id));

    return result;
  });
}

/** One vault the purge removed. */
export interface PurgedRetainedVault {
  id: string;
  userId: string;
  retainedAt: Date;
  purgeAfter: Date;
  grantCount: number;
}

/**
 * Deletes retained vaults whose window has ended — at most `limit` per call.
 *
 * The only DELETE on these tables anywhere in the application, and it names
 * `purge_after <= now` twice: once to choose the rows, under `SKIP LOCKED` so two
 * purges running at once take different rows instead of waiting on each other,
 * and again on the delete itself. Below that, migration 0020's trigger refuses a
 * delete of any row still inside its window by the database's own clock, so a
 * caller whose `now` ran fast deletes nothing early: the statement fails.
 *
 * The wraps and grants go with each vault, by cascade.
 */
export async function purgeExpiredRetainedVaults(
  exec: Executor,
  now: Date,
  limit: number,
): Promise<PurgedRetainedVault[]> {
  return exec.transaction(async (tx) => {
    const doomed = await tx
      .select({
        id: retainedVaults.id,
        userId: retainedVaults.userId,
        retainedAt: retainedVaults.retainedAt,
        purgeAfter: retainedVaults.purgeAfter,
      })
      .from(retainedVaults)
      .where(lte(retainedVaults.purgeAfter, now))
      .orderBy(asc(retainedVaults.purgeAfter))
      .limit(limit)
      .for('update', { skipLocked: true });

    if (doomed.length === 0) return [];
    const ids = doomed.map((vault) => vault.id);

    const counts = await tx
      .select({ id: retainedVaultGrants.retainedVaultId, total: count() })
      .from(retainedVaultGrants)
      .where(inArray(retainedVaultGrants.retainedVaultId, ids))
      .groupBy(retainedVaultGrants.retainedVaultId);
    const grantsBy = new Map(counts.map((row) => [row.id, row.total]));

    await tx
      .delete(retainedVaults)
      .where(and(inArray(retainedVaults.id, ids), lte(retainedVaults.purgeAfter, now)));

    return doomed.map((vault) => ({ ...vault, grantCount: grantsBy.get(vault.id) ?? 0 }));
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
