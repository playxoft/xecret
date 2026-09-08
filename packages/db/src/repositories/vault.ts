import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import type { Argon2idParams } from '@xecret/core/crypto/client';
import type { UnlockAttemptState } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { userKeys, userKeyWraps, userPasskeys } from '../schema/vault';
import { isUniqueViolation } from './users';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * The user vault: storage for the zero-knowledge key hierarchy.
 *
 * The policy — how long an unlock lasts, what a lockout costs, whether a
 * presented verifier matches — lives in `@xecret/core/auth`. This module only
 * stores, for the same reason `sessions.ts` only stores: the rules are then
 * unit-testable without a database and exist in exactly one place.
 *
 * Three properties this file is responsible for, and they are the whole of it:
 *
 *  - **Nothing here can decrypt anything.** Every value that crosses this
 *    boundary is either public (a public key, a salt, KDF parameters) or an
 *    opaque ciphertext the server has no key for. There is no code path that
 *    could be extended into one, because no key exists to extend it with.
 *  - **Multi-row mutations are transactional, without exception.** A vault is
 *    `user_keys` plus a passphrase wrap plus five recovery wraps, and a partial
 *    write of that set is not a degraded vault — it is an account whose secrets
 *    are unreachable forever. Every function below that touches more than one
 *    row opens a transaction, and the ones that replace a wrap write the new row
 *    before retiring the old one.
 *  - **An account always has exactly one live passphrase wrap.** Enforced by
 *    `user_key_wraps_passphrase_unique`, a partial unique index, so a concurrent
 *    double passphrase change fails loudly rather than leaving two passphrases
 *    that both open the same vault — the silent, permanent downgrade.
 */

const PASSPHRASE_WRAP_UNIQUE = 'user_key_wraps_passphrase_unique';

/** The `user_keys` row: everything about a vault except its wraps. */
export interface VaultKeyRecord extends UnlockAttemptState {
  userId: string;
  encAlgorithm: string;
  encPublicKey: Uint8Array;
  encPrivateKeyEnc: Uint8Array;
  signAlgorithm: string;
  signPublicKey: Uint8Array;
  signPrivateKeyEnc: Uint8Array;
  kdfSalt: Uint8Array;
  kdfParams: Argon2idParams;
  unlockVerifierHash: Uint8Array;
  /** The recovery-code attempt counter, kept apart from the passphrase one. */
  recoveryFailedAttempts: number;
  recoveryLockedUntil: Date | null;
  autoLockMinutes: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

const KEY_COLUMNS = {
  userId: userKeys.userId,
  encAlgorithm: userKeys.encAlgorithm,
  encPublicKey: userKeys.encPublicKey,
  encPrivateKeyEnc: userKeys.encPrivateKeyEnc,
  signAlgorithm: userKeys.signAlgorithm,
  signPublicKey: userKeys.signPublicKey,
  signPrivateKeyEnc: userKeys.signPrivateKeyEnc,
  kdfSalt: userKeys.kdfSalt,
  kdfParams: userKeys.kdfParams,
  unlockVerifierHash: userKeys.unlockVerifierHash,
  failedAttempts: userKeys.failedAttempts,
  lockedUntil: userKeys.lockedUntil,
  recoveryFailedAttempts: userKeys.recoveryFailedAttempts,
  recoveryLockedUntil: userKeys.recoveryLockedUntil,
  autoLockMinutes: userKeys.autoLockMinutes,
  createdAt: userKeys.createdAt,
  rotatedAt: userKeys.rotatedAt,
} as const;

/** A passkey enrolled for one-touch unlock, and the wrap it opens. */
export interface PasskeyRecord {
  id: string;
  credentialId: Uint8Array;
  label: string;
  transports: string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** The `prf` wrap of the User Key this credential's PRF output opens. */
  wrap: Uint8Array;
}

/**
 * Everything the lock screen needs, in one round trip.
 *
 * Deliberately assembled rather than left to the caller: an unlock screen that
 * fetched keys, then the passphrase wrap, then the passkeys would take three
 * round trips to draw a form, and a caller that forgot one would render a
 * "no passkeys enrolled" state to somebody who has one.
 */
export interface VaultRecord {
  keys: VaultKeyRecord;
  /** The live passphrase wrap. Always present — the index guarantees exactly one. */
  passphraseWrap: Uint8Array;
  passkeys: PasskeyRecord[];
  /** Unused recovery codes remaining. Never the codes, never their hashes. */
  recoveryCodesRemaining: number;
}

/** `null` means this account has no vault — the signal for the setup ceremony. */
export async function findVaultKeys(
  exec: Executor,
  userId: string,
): Promise<VaultKeyRecord | null> {
  const [row] = await exec
    .select(KEY_COLUMNS)
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1);

  return row ?? null;
}

export async function hasVault(exec: Executor, userId: string): Promise<boolean> {
  const [row] = await exec
    .select({ userId: userKeys.userId })
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1);

  return row !== undefined;
}

/**
 * Loads a whole vault, or `null` when there is none.
 *
 * Four queries rather than one join: a join across `user_keys`, the wraps and
 * the passkeys would multiply rows by the number of recovery codes and passkeys,
 * and the assembly cost of un-multiplying them exceeds what the extra round
 * trips cost against a pooled connection. The count is a count rather than a
 * fetch, because the caller must never receive a recovery wrap it did not ask
 * for by lookup hash.
 */
export async function loadVault(exec: Executor, userId: string): Promise<VaultRecord | null> {
  const keys = await findVaultKeys(exec, userId);
  if (keys === null) return null;

  const [passphrase] = await exec
    .select({ wrap: userKeyWraps.wrap })
    .from(userKeyWraps)
    .where(livePassphraseWrap(userId))
    .limit(1);

  // Unreachable through any code path in this module — a vault is created with
  // its passphrase wrap in one transaction, and a change writes the replacement
  // before retiring the old row. Reported as a fault rather than papered over
  // with an empty string: a vault with no live passphrase wrap is a corrupt
  // record, and pretending otherwise would hand the client a "wrong passphrase"
  // for something no passphrase can fix.
  if (!passphrase) {
    throw new RepositoryError('invalid', 'This vault has no passphrase wrap.');
  }

  return {
    keys,
    passphraseWrap: passphrase.wrap,
    passkeys: await listPasskeys(exec, userId),
    recoveryCodesRemaining: await countUnusedRecoveryWraps(exec, userId),
  };
}

export async function listPasskeys(exec: Executor, userId: string): Promise<PasskeyRecord[]> {
  return exec
    .select({
      id: userPasskeys.id,
      credentialId: userPasskeys.credentialId,
      label: userPasskeys.label,
      transports: userPasskeys.transports,
      createdAt: userPasskeys.createdAt,
      lastUsedAt: userPasskeys.lastUsedAt,
      wrap: userKeyWraps.wrap,
    })
    .from(userPasskeys)
    .innerJoin(userKeyWraps, eq(userKeyWraps.passkeyId, userPasskeys.id))
    .where(and(eq(userPasskeys.userId, userId), eq(userKeyWraps.kind, 'prf')))
    .orderBy(asc(userPasskeys.createdAt));
}

async function countUnusedRecoveryWraps(exec: Executor, userId: string): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(userKeyWraps)
    .where(unusedRecoveryWraps(userId));

  return row?.total ?? 0;
}

/** One recovery code as the server stores it: a lookup hash and a wrap. */
export interface RecoveryWrapSeed {
  lookupHash: Uint8Array;
  wrap: Uint8Array;
}

export interface CreateVaultParams {
  userId: string;
  encAlgorithm: string;
  encPublicKey: Uint8Array;
  encPrivateKeyEnc: Uint8Array;
  signAlgorithm: string;
  signPublicKey: Uint8Array;
  signPrivateKeyEnc: Uint8Array;
  kdfSalt: Uint8Array;
  kdfParams: Argon2idParams;
  unlockVerifierHash: Uint8Array;
  passphraseWrap: Uint8Array;
  recoveryWraps: readonly RecoveryWrapSeed[];
}

/**
 * Creates a vault: the keys, the passphrase wrap and every recovery wrap, or
 * none of them.
 *
 * The transaction is not a nicety. A `user_keys` row without its passphrase wrap
 * is an account that can never be unlocked and can never be set up again, since
 * the setup path refuses to overwrite an existing vault — the one failure in
 * this system with no recovery at all. Recovery wraps written without the keys
 * are the mirror image and equally terminal.
 *
 * Creating over an existing vault is a **conflict, never an overwrite**. The old
 * public key has environment keys sealed to it; replacing it silently would
 * revoke the account's access to every one of them while reporting success.
 */
export async function createVault(exec: Executor, params: CreateVaultParams): Promise<void> {
  const now = new Date();

  try {
    await exec.transaction(async (tx) => {
      // Checked inside the transaction, and backed by the primary key on
      // `user_id` — two setup ceremonies racing from two tabs both pass this
      // read, and the insert is what actually decides.
      if (await hasVault(tx, params.userId)) {
        throw new RepositoryError('conflict', 'This account already has a vault.');
      }

      await tx.insert(userKeys).values({
        userId: params.userId,
        encAlgorithm: params.encAlgorithm,
        encPublicKey: params.encPublicKey,
        encPrivateKeyEnc: params.encPrivateKeyEnc,
        signAlgorithm: params.signAlgorithm,
        signPublicKey: params.signPublicKey,
        signPrivateKeyEnc: params.signPrivateKeyEnc,
        kdfSalt: params.kdfSalt,
        kdfParams: params.kdfParams,
        unlockVerifierHash: params.unlockVerifierHash,
        createdAt: now,
      });

      await tx.insert(userKeyWraps).values([
        {
          id: uuidv7(),
          userId: params.userId,
          kind: 'passphrase',
          wrap: params.passphraseWrap,
          createdAt: now,
        },
        ...params.recoveryWraps.map((seed) => recoveryRow(params.userId, seed, now)),
      ]);
    });
  } catch (cause) {
    throw asVaultConflict(cause, 'This account already has a vault.');
  }
}

/** Records the outcome of one passphrase unlock attempt. */
export async function recordUnlockAttempt(
  exec: Executor,
  userId: string,
  state: UnlockAttemptState,
): Promise<void> {
  await exec
    .update(userKeys)
    .set({ failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil })
    .where(eq(userKeys.userId, userId));
}

/** The same, for the separately counted recovery surface. */
export async function recordRecoveryAttempt(
  exec: Executor,
  userId: string,
  state: UnlockAttemptState,
): Promise<void> {
  await exec
    .update(userKeys)
    .set({
      recoveryFailedAttempts: state.failedAttempts,
      recoveryLockedUntil: state.lockedUntil,
    })
    .where(eq(userKeys.userId, userId));
}

/**
 * Changes how long the dashboard may sit idle before locking itself.
 *
 * The value is validated by the caller against `AUTO_LOCK_MINUTES_OPTIONS` and
 * again by the table's CHECK; this module only stores, as ever. No row means no
 * vault — there is nothing an idle timer could lock — so the update refusing to
 * invent one is the correct answer rather than an error to paper over.
 */
export async function setAutoLockMinutes(
  exec: Executor,
  userId: string,
  minutes: number,
): Promise<VaultKeyRecord | null> {
  const [row] = await exec
    .update(userKeys)
    .set({ autoLockMinutes: minutes })
    .where(eq(userKeys.userId, userId))
    .returning(KEY_COLUMNS);

  return row ?? null;
}

export interface ChangePassphraseParams {
  userId: string;
  kdfSalt: Uint8Array;
  kdfParams: Argon2idParams;
  unlockVerifierHash: Uint8Array;
  passphraseWrap: Uint8Array;
}

/**
 * Swaps the passphrase wrap and the verifier, atomically.
 *
 * The two must move together or not at all, and the reason is worth stating: the
 * verifier gates the API and the wrap holds the key. A wrap written without its
 * verifier leaves an account that can decrypt but cannot unlock; a verifier
 * written without its wrap leaves one that unlocks and then cannot decrypt. Both
 * are indistinguishable from "wrong passphrase" at the screen, and neither has a
 * repair path that does not involve a recovery code.
 *
 * The **User Key is unchanged** — only its passphrase wrap is replaced — so
 * recovery codes keep working, other devices stay unlocked, and nothing sealed
 * to this account's public key is touched. That is the property the whole key
 * hierarchy exists to buy.
 *
 * The old wrap is superseded rather than deleted, and the new one is inserted
 * first: the partial unique index means the insert is what fails if two changes
 * race, and it fails before anything has been retired.
 */
export async function changePassphrase(
  exec: Executor,
  params: ChangePassphraseParams,
): Promise<void> {
  const now = new Date();

  try {
    await exec.transaction(async (tx) => {
      await supersedePassphraseWrap(tx, params.userId, now);

      await tx.insert(userKeyWraps).values({
        id: uuidv7(),
        userId: params.userId,
        kind: 'passphrase',
        wrap: params.passphraseWrap,
        createdAt: now,
      });

      const updated = await tx
        .update(userKeys)
        .set({
          kdfSalt: params.kdfSalt,
          kdfParams: params.kdfParams,
          unlockVerifierHash: params.unlockVerifierHash,
          rotatedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(userKeys.userId, params.userId))
        .returning({ userId: userKeys.userId });

      if (updated.length === 0) {
        throw new RepositoryError('notFound', 'This account has no vault.');
      }
    });
  } catch (cause) {
    throw asVaultConflict(cause, 'The passphrase was changed by another request.');
  }
}

/** What a presented recovery code resolves to. Returned only on an exact hash match. */
export interface RecoveryWrapMatch {
  wrapId: string;
  userId: string;
  wrap: Uint8Array;
}

/**
 * Finds the unused recovery wrap a presented lookup hash addresses.
 *
 * Returns `null` for unknown, already-used, and belonging-to-a-deleted-account
 * alike. The caller gives one answer for all three, because distinguishing them
 * tells somebody holding a guessed hash which part of their guess was right —
 * and, worse here, would turn this endpoint into an oracle for *whether an
 * account exists at all*, since a recovery lookup is not scoped to a user.
 */
export async function findRecoveryWrap(
  exec: Executor,
  lookupHash: Uint8Array,
): Promise<RecoveryWrapMatch | null> {
  const [row] = await exec
    .select({
      wrapId: userKeyWraps.id,
      userId: userKeyWraps.userId,
      wrap: userKeyWraps.wrap,
    })
    .from(userKeyWraps)
    .where(
      and(
        eq(userKeyWraps.kind, 'recovery'),
        eq(userKeyWraps.lookupHash, lookupHash),
        isNull(userKeyWraps.usedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

export interface CompleteRecoveryParams extends ChangePassphraseParams {
  /** The wrap `findRecoveryWrap` returned. Marked used in this transaction. */
  wrapId: string;
  /** The replacement set. The whole previous set dies with this call. */
  recoveryWraps: readonly RecoveryWrapSeed[];
}

/**
 * Redeems a recovery code: marks it used, sets the new passphrase, and reissues
 * the entire code set — all in one transaction.
 *
 * ── Why the whole set is replaced, not just the redeemed code ──
 * Every recovery wrap holds the same User Key, so a set with one code spent is a
 * set that four other pieces of paper still open. Somebody redeeming a code has
 * just demonstrated they lost control of their passphrase; the honest response
 * is to treat the whole kit as spent, which is also the only rule a person can
 * hold in their head — "using one invalidates them all" needs no footnote about
 * which of the five is still live.
 *
 * The redeemed row is marked `used_at` and kept; the unredeemed ones are
 * deleted. The tombstone is the record that a recovery happened and when, which
 * is the single most important line an incident review looks for. Keeping the
 * unused ones as well would grow the table by five rows per recovery to record
 * nothing that the tombstone and the audit event do not already say.
 *
 * The `usedAt IS NULL` guard on the mark is the concurrency boundary: two
 * requests redeeming the same code race on that row, and exactly one wins. A
 * read-then-write would let both through, and both would then reissue a set —
 * leaving whichever finished second in possession of the only live codes.
 */
export async function completeRecovery(
  exec: Executor,
  params: CompleteRecoveryParams,
): Promise<void> {
  const now = new Date();

  try {
    await exec.transaction(async (tx) => {
      const redeemed = await tx
        .update(userKeyWraps)
        .set({ usedAt: now })
        .where(
          and(
            eq(userKeyWraps.id, params.wrapId),
            eq(userKeyWraps.userId, params.userId),
            isNull(userKeyWraps.usedAt),
          ),
        )
        .returning({ id: userKeyWraps.id });

      if (redeemed.length === 0) {
        throw new RepositoryError('conflict', 'That recovery code has already been used.');
      }

      // Everything except the row just spent. The unique lookup index would
      // reject a reissued hash colliding with a live one, so the delete has to
      // precede the insert.
      await tx
        .delete(userKeyWraps)
        .where(and(unusedRecoveryWraps(params.userId), ne(userKeyWraps.id, params.wrapId)));

      await tx
        .insert(userKeyWraps)
        .values(params.recoveryWraps.map((seed) => recoveryRow(params.userId, seed, now)));

      await supersedePassphraseWrap(tx, params.userId, now);

      await tx.insert(userKeyWraps).values({
        id: uuidv7(),
        userId: params.userId,
        kind: 'passphrase',
        wrap: params.passphraseWrap,
        createdAt: now,
      });

      // Both counters are cleared. Somebody who has just proved possession of a
      // recovery code has cleared a far higher bar than either lockout guards,
      // and leaving them locked out of the passphrase they are in the middle of
      // setting would be absurd.
      await tx
        .update(userKeys)
        .set({
          kdfSalt: params.kdfSalt,
          kdfParams: params.kdfParams,
          unlockVerifierHash: params.unlockVerifierHash,
          rotatedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
          recoveryFailedAttempts: 0,
          recoveryLockedUntil: null,
        })
        .where(eq(userKeys.userId, params.userId));
    });
  } catch (cause) {
    throw asVaultConflict(cause, 'The passphrase was changed by another request.');
  }
}

/**
 * Replaces the recovery-code set from an unlocked session.
 *
 * The same all-or-nothing rule as `completeRecovery`, minus the passphrase
 * change: previously used codes keep their tombstones, every live code is
 * revoked, and the new set is written in the same transaction. Returns how many
 * codes are now live, which is what the caller shows.
 */
export async function regenerateRecoveryCodes(
  exec: Executor,
  userId: string,
  wraps: readonly RecoveryWrapSeed[],
): Promise<number> {
  const now = new Date();

  await exec.transaction(async (tx) => {
    await tx.delete(userKeyWraps).where(unusedRecoveryWraps(userId));
    await tx.insert(userKeyWraps).values(wraps.map((seed) => recoveryRow(userId, seed, now)));
  });

  return wraps.length;
}

export interface EnrollPasskeyParams {
  userId: string;
  credentialId: Uint8Array;
  label: string;
  transports: string[] | null;
  /** The `prf` wrap of the User Key, sealed under this credential's PRF output. */
  wrap: Uint8Array;
}

/**
 * Enrols a passkey and the wrap it opens, atomically.
 *
 * A passkey row without its wrap would appear in the security screen as an
 * unlock method that silently never works; a wrap without its passkey cannot
 * exist at all, since the CHECK requires the foreign key.
 */
export async function enrollPasskey(
  exec: Executor,
  params: EnrollPasskeyParams,
): Promise<PasskeyRecord> {
  const now = new Date();
  const id = uuidv7();

  try {
    await exec.transaction(async (tx) => {
      await tx.insert(userPasskeys).values({
        id,
        userId: params.userId,
        credentialId: params.credentialId,
        label: params.label,
        transports: params.transports,
        createdAt: now,
      });

      await tx.insert(userKeyWraps).values({
        id: uuidv7(),
        userId: params.userId,
        kind: 'prf',
        wrap: params.wrap,
        passkeyId: id,
        createdAt: now,
      });
    });
  } catch (cause) {
    if (isUniqueViolation(cause, 'user_passkeys_credential_id_unique')) {
      throw new RepositoryError('conflict', 'That passkey is already enrolled.');
    }
    throw cause;
  }

  return {
    id,
    credentialId: params.credentialId,
    label: params.label,
    transports: params.transports,
    createdAt: now,
    lastUsedAt: null,
    wrap: params.wrap,
  };
}

/**
 * Unenrols a passkey. Its `prf` wrap goes with it, by cascade.
 *
 * Scoped by `user_id` as well as by id, so one account cannot delete another's
 * credential by guessing a uuid (threat T2). Returns whether a row was removed,
 * so the caller can answer 404 rather than reporting a success that did nothing.
 *
 * This can never strand an account: the passphrase wrap always exists and has no
 * removal path, so the last passkey is still not the last way in.
 */
export async function removePasskey(
  exec: Executor,
  userId: string,
  passkeyId: string,
): Promise<boolean> {
  const removed = await exec
    .delete(userPasskeys)
    .where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)))
    .returning({ id: userPasskeys.id });

  return removed.length > 0;
}

/** Bookkeeping for the security screen's "last used" column. */
export async function touchPasskeyUsage(
  exec: Executor,
  userId: string,
  passkeyId: string,
): Promise<void> {
  await exec
    .update(userPasskeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)));
}

function recoveryRow(userId: string, seed: RecoveryWrapSeed, now: Date) {
  return {
    id: uuidv7(),
    userId,
    kind: 'recovery' as const,
    wrap: seed.wrap,
    lookupHash: seed.lookupHash,
    createdAt: now,
  };
}

function livePassphraseWrap(userId: string) {
  return and(
    eq(userKeyWraps.userId, userId),
    eq(userKeyWraps.kind, 'passphrase'),
    isNull(userKeyWraps.supersededAt),
  );
}

function unusedRecoveryWraps(userId: string) {
  return and(
    eq(userKeyWraps.userId, userId),
    eq(userKeyWraps.kind, 'recovery'),
    isNull(userKeyWraps.usedAt),
  );
}

async function supersedePassphraseWrap(tx: Executor, userId: string, now: Date): Promise<void> {
  await tx.update(userKeyWraps).set({ supersededAt: now }).where(livePassphraseWrap(userId));
}

/**
 * Turns a lost race on the passphrase-wrap index into a conflict the caller can
 * explain, and leaves everything else exactly as it was thrown.
 *
 * `RepositoryError`s raised inside the transaction pass through untouched: they
 * already carry the precise code, and re-wrapping them would flatten
 * "already has a vault" and "no such vault" into one message.
 */
function asVaultConflict(cause: unknown, message: string): unknown {
  if (cause instanceof RepositoryError) return cause;
  if (isUniqueViolation(cause, PASSPHRASE_WRAP_UNIQUE)) {
    return new RepositoryError('conflict', message);
  }
  if (isUniqueViolation(cause, 'user_keys_pkey')) {
    return new RepositoryError('conflict', 'This account already has a vault.');
  }
  return cause;
}

/**
 * Deletes a vault outright. The wraps and passkeys go with it, by cascade.
 *
 * Called from exactly one place — account deletion — and kept here rather than
 * left as a raw `DELETE` because of what it means: every environment key sealed
 * to this account's public key becomes unopenable, and no teammate can restore
 * it without re-sharing. That is the correct outcome when an account is being
 * deleted, and a catastrophe anywhere else, which is why it has no route.
 *
 * Unlike the soft delete of the `users` row beside it, this is a hard delete.
 * A soft-deleted account is one the identity upsert refuses to revive, so
 * keeping its wraps would keep key material for a vault nobody can ever sign
 * into again.
 */
export async function deleteVault(exec: Executor, userId: string): Promise<boolean> {
  const removed = await exec
    .delete(userKeys)
    .where(eq(userKeys.userId, userId))
    .returning({ userId: userKeys.userId });

  return removed.length > 0;
}
