import { evaluateUnlockLockout, nextUnlockFailure, unlockVerifierMatches } from '@xecret/core/auth';
import { can } from '@xecret/core/authz';
import { fromBase64Url } from '@xecret/core/crypto';
import {
  findRetainedRecoveryWrap,
  listRetainedVaults,
  loadAuthorizationContext,
  loadRetainedVault,
  recordRetainedRecoveryAttempt,
  RepositoryError,
  restoreRetainedGrants,
  toBytes,
} from '@xecret/db/repositories';
import type { RestoreResult, RetainedVaultMaterial } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { toRetainedVault, toRetainedVaultMaterial } from './schemas/retained-vaults';
import type {
  RetainedRestoreRequest,
  RetainedVaultMaterialPayload,
  RetainedVaultPayload,
} from './schemas/retained-vaults';
import { decodeBlob, encodeBlob } from './schemas/vault';
import { toGrantContext } from './tenancy';

/**
 * Recovering a reset vault inside its seven-day window (P23).
 *
 * ── What recovery is, precisely ──
 * Not a swap back. The account keeps the vault it set up after the reset — its
 * passphrase, its recovery kit, its passkeys — and the retained vault's
 * environment keys are brought *into* it: the browser opens the retained vault
 * with the old passphrase or one of the old recovery codes, opens each of its
 * grants, re-seals every key to the current vault's public key, signs them with
 * the current vault's signing key, and posts them here. The server writes them
 * as ordinary member grants. Afterwards the account has exactly one working key
 * hierarchy — the current one — holding every key either vault held, and the
 * retained vault is inert until the purge removes it.
 *
 * So nothing sealed to the current vault is touched, and nothing written during
 * the window is at risk: a teammate's re-share stays (the same key, skipped as
 * `already-held`), an environment created since stays, and every secret written
 * since was written under an environment key, which a reset never changes.
 *
 * ── Who may do it ──
 * The account's owner, from an **unlocked** session — the route gate, not a
 * convenience: re-sealing to the current vault needs its private keys, and a
 * stolen cookie that cannot unlock cannot recover. Then the retained vault is
 * found only by its owner's id and only inside its window, and the restore must
 * present `ukUnlockVerifier`, which only somebody who opened the retained
 * vault's User Key can derive. Every failure of that proof counts against the
 * retained vault's own lockout.
 *
 * ── What it never restores ──
 * Access the account no longer has. Each environment goes through the same
 * `can(secret.read)` every request does, inside the restore's transaction, and
 * one the account has lost since the reset is skipped as `no-access`. A
 * recovery is not a way to undo a revocation that happened during the window.
 */

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** The account's reset vaults still inside their window. */
export async function listRetained(
  services: ServiceContext,
  user: UserPrincipal,
  now: Date = new Date(),
): Promise<RetainedVaultPayload[]> {
  return (await listRetainedVaults(services.db, user.user.id, now)).map(toRetainedVault);
}

/** Everything the browser needs to open one, or a 404 — for another account's alike. */
export async function retainedMaterial(
  services: ServiceContext,
  user: UserPrincipal,
  retainedVaultId: string,
  now: Date = new Date(),
): Promise<RetainedVaultMaterialPayload> {
  return toRetainedVaultMaterial(await requireRetained(services, user, retainedVaultId, now));
}

/**
 * The retained wrap a recovery code's lookup hash addresses.
 *
 * One answer for every miss — unknown, used by the reset, another vault's — so
 * the endpoint is not an oracle for which codes a vault had, and each miss is
 * counted against this retained vault's lockout before it is answered.
 */
export async function retainedRecoveryWrap(
  services: ServiceContext,
  user: UserPrincipal,
  retainedVaultId: string,
  lookupHash: string,
  now: Date = new Date(),
): Promise<string> {
  const vault = await requireRetained(services, user, retainedVaultId, now);
  assertNotLocked(vault, now);

  const wrap = await findRetainedRecoveryWrap(services.db, {
    userId: user.user.id,
    retainedVaultId: vault.id,
    lookupHash: fromBase64Url(lookupHash),
    now,
  });

  if (wrap === null) {
    await recordFailure(services, vault, now, 'recovery-code');
    throw errors.badRequest('That recovery code is not one of this vault’s.');
  }
  return decodeBlob(wrap);
}

/**
 * Writes the retained vault's keys into the current vault, after checking the
 * proof that its User Key was opened.
 */
export async function restoreRetained(
  services: ServiceContext,
  user: UserPrincipal,
  retainedVaultId: string,
  body: RetainedRestoreRequest,
  now: Date = new Date(),
): Promise<RestoreResult> {
  const vault = await requireRetained(services, user, retainedVaultId, now);
  assertNotLocked(vault, now);

  const matched = await unlockVerifierMatches(
    fromBase64Url(body.ukUnlockVerifier),
    toBytes(vault.ukUnlockVerifierHash),
  );
  if (!matched) {
    await recordFailure(services, vault, now, 'restore');
    // 403, not 401: the session is fine, and the client's API layer sends a
    // 401 to the sign-in page.
    throw errors.forbidden('That does not open this vault.');
  }

  try {
    return await restoreRetainedGrants(services.db, {
      userId: user.user.id,
      retainedVaultId: vault.id,
      now,
      grants: body.grants.map((grant) => ({
        envDataKeyId: grant.envDataKeyId,
        recipientPublicKey: fromBase64Url(grant.recipientPublicKey),
        edkSealed: encodeBlob(grant.edkSealed),
        ehkSealed: encodeBlob(grant.ehkSealed),
        signature: encodeBlob(grant.signature),
      })),
      authorize: async (tx, targets) => {
        const readable = new Set<string>();
        const contexts = new Map<string, Awaited<ReturnType<typeof loadAuthorizationContext>>>();
        for (const target of targets) {
          if (!contexts.has(target.orgId)) {
            contexts.set(
              target.orgId,
              await loadAuthorizationContext(tx, { orgId: target.orgId, userId: user.user.id }),
            );
          }
          const context = contexts.get(target.orgId) ?? null;
          if (context === null) continue;

          const allowed = can(
            { kind: 'user', userId: user.user.id, orgId: target.orgId },
            'secret.read',
            {
              kind: 'environment',
              orgId: target.orgId,
              projectId: target.projectId,
              environmentId: target.environmentId,
            },
            { membership: toGrantContext(context), isProduction: target.isProduction },
          ).allowed;
          if (allowed) readable.add(target.environmentId);
        }
        return readable;
      },
    });
  } catch (cause) {
    if (cause instanceof RepositoryError) {
      if (cause.code === 'notFound') throw errors.notFound('no such retained vault');
      if (cause.code === 'conflict') throw errors.conflict(cause.message);
      throw errors.badRequest(cause.message);
    }
    throw cause;
  }
}

async function requireRetained(
  services: ServiceContext,
  user: UserPrincipal,
  retainedVaultId: string,
  now: Date,
): Promise<RetainedVaultMaterial> {
  const vault = await loadRetainedVault(services.db, user.user.id, retainedVaultId, now);
  // The same 404 whether the id is another account's, nobody's, or past its
  // window (threat T2).
  if (vault === null) throw errors.notFound('no such retained vault');
  return vault;
}

function assertNotLocked(vault: RetainedVaultMaterial, now: Date): void {
  const lockout = evaluateUnlockLockout(vault, now);
  if (lockout.locked) throw errors.vaultLocked(lockout.retryAfterMs);
}

/** Awaited, never deferred: a failure a client can avoid paying for by hanging up is not counted. */
async function recordFailure(
  services: ServiceContext,
  vault: RetainedVaultMaterial,
  now: Date,
  surface: 'recovery-code' | 'restore',
): Promise<void> {
  const state = nextUnlockFailure(vault, now);
  await recordRetainedRecoveryAttempt(services.db, vault.id, state);
  services.log
    .at('retainedVault')
    .warn(
      'Rejected a proof against a retained vault — it has now failed ' +
        `${state.failedAttempts} time(s) in a row and will lock if it keeps failing`,
      { failedAttempts: state.failedAttempts, surface },
    );
}
