import { and, count, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { envKeys } from '../schema/keys';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { organizations } from '../schema/tenancy';
import { serviceTokens } from '../schema/tokens';
import { userKeys } from '../schema/vault';
import { initializeEnvironmentKeys } from './env-keys';
import type { EnvDataKeyRecord, EnvKeyGrantSeed } from './env-keys';
import { reencryptVersionsInPlace, sealNotesInPlace, secretRevision } from './secrets';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Upgrading a `server`-mode environment to end-to-end encryption, in place
 * (ADR 0009, Phase 5).
 *
 * ── What "in place" means, and why it is the design ──
 * The environment row survives: its id, its slug, its access grants, its
 * policies, its webhooks, its CI tokens' scope and the read-alert settings all
 * stay attached, because nothing about them depended on which key the values
 * were under. (No template reaches into a `server`-mode environment and none
 * inherits from one — both need end-to-end encryption — so there is no
 * reference graph to carry across.) What changes is everything that did:
 *
 *  - every version of every live secret is rewritten from the server envelope
 *    to an `xk2.gcm.` blob the upgrading browser produced, under a key that
 *    browser generated — same row, same version number, same author;
 *  - every note moves from the plaintext `note` column to `enc_note`;
 *  - the environment gains a data key, an HMAC key and the upgrader's own grant
 *    (the same three rows a newly created environment starts with);
 *  - and the `env_keys` row the Worker could unwrap is **deleted**, so that
 *    after the commit no key this server holds opens anything here.
 *
 * ── What it erases, and why it has to ──
 * Two things cannot cross, and both are named in the request so the person
 * pressing the button has seen exactly what goes:
 *
 *  - **Soft-deleted secrets.** The browser is handed live secrets only, and
 *    their versions reference `env_keys` through an `ON DELETE RESTRICT` key —
 *    so they would either stay readable by the server or block the delete of
 *    the key that makes the upgrade mean anything. They are erased now rather
 *    than at the end of the thirty-day purge, which is earlier erasure on an
 *    explicit request, said so in the dialog and recorded per secret.
 *  - **Service tokens with no key half.** A `server`-mode token carries no
 *    public key, so there is nothing to seal the new key to and it could never
 *    read the environment again. Left alone it would keep authenticating to
 *    list names and fail every read; revoked, it fails loudly and says why.
 *
 * ── Why the set is checked here, under locks, and not trusted ──
 * The browser read the environment, re-encrypted it, and sent the result. A
 * write that landed in between — a new version, a new secret, a changed note,
 * a soft delete, a restore, a token minted — would otherwise be silently
 * dropped (a version the browser never saw would be left under a key this
 * transaction then deletes, so it would fail at the delete instead), or worse,
 * its effect overwritten with what the browser saw. So the transaction takes
 * the locks every such writer has to queue behind and then compares the stored
 * world to the submitted one **exactly**: every live secret, its revision, every
 * version by id and number, every soft-deleted secret, every keyless token. Any
 * difference is a conflict and nothing is written.
 *
 * The locks, in the order they are taken, and who each one stops:
 *
 *  1. the organisation row, **`FOR SHARE`** — membership and access changes take
 *     it `FOR UPDATE` (`lockOrganization`), so the share queue written at the
 *     end is computed from a roster that cannot move under it. Share, not
 *     update: every insert that references the organisation takes `FOR KEY
 *     SHARE` on it through its foreign key, and an upgrade holding the row
 *     exclusively would stall every one of those across the organisation for
 *     its whole length — and could close a cycle with a writer that holds this
 *     environment and then inserts such a row (a service token being minted).
 *     Two upgrades of different environments share it without waiting.
 *  2. the upgrader's `user_keys` row, `FOR SHARE` — the public key the new
 *     key's first grant must be sealed to cannot be replaced by a vault reset
 *     between the check and the commit.
 *  3. the environment row, `FOR UPDATE` — a concurrent upgrade, a deletion, a
 *     settings change, and **every mode-dependent writer**: a server-mode value
 *     write, a plaintext note and a keyless token being minted each read the
 *     mode with `lockEnvironmentMode` (`FOR SHARE`) as the first row lock of
 *     their own transaction.
 *  4. every `secrets` row of the environment, `FOR UPDATE` — renames, notes,
 *     soft deletes and restores of existing rows.
 *  5. the environment's `env_keys` rows, `FOR UPDATE`.
 *
 * ── Why that order cannot deadlock ──
 * A server-mode value write takes, in its own transaction and in this order:
 * the plan's capacity advisory lock, the environment row (`FOR SHARE`), then —
 * through the foreign keys of its inserts — the secret (`FOR KEY SHARE`), the
 * `env_keys` row (`FOR KEY SHARE`), the environment again for a create, and the
 * secret (`FOR NO KEY UPDATE`) to bump its `updated_at`. Before the mode lock
 * existed it took no environment lock first, and its secret-then-key order was
 * the reverse of the key-then-secret order this function used to take: each
 * could hold the row the other waited for (`40P01`), and an import that
 * appended and then created could do the same with the key and the environment
 * row. Now both sides reach the environment row first, so one of them waits
 * there holding nothing the other needs — the writer holds only an advisory
 * lock this transaction never takes, and this transaction holds only the
 * organisation and its own vault row `FOR SHARE`, which no writer's `FOR KEY
 * SHARE` conflicts with. Secrets before keys here matches the writers' own
 * foreign-key order besides, and a deadlock some path nobody listed still
 * manages to produce is answered as a retryable conflict (`isTransactionRace`),
 * never as a 500.
 *
 * ── Why it is a repository function at all ──
 * Every statement is a fact about rows, and the two decisions that are not —
 * who may perform it, and who should be queued a key share afterwards — come in
 * from the service layer as a checked body and a callback, the seam
 * `rotateEnvDataKey` uses for the same reason.
 */

/** One version as the browser re-encrypted it. */
export interface UpgradedVersion {
  /** The `secret_versions` row id. */
  id: string;
  version: number;
  /** The ASCII of an `xk2.gcm.` blob. */
  ciphertext: Uint8Array;
  clientAlgorithm: string;
  valueHmac: Uint8Array;
}

/** One live secret, with every version and its note re-encrypted. */
export interface UpgradedSecret {
  id: string;
  /** The staleness token the browser was served — see `HistorySecret.revision`. */
  revision: string;
  /** The note sealed under the new key, or `null` for a secret with none. */
  encNote: Uint8Array | null;
  versions: readonly UpgradedVersion[];
}

export interface UpgradeEnvironmentParams {
  orgId: string;
  environmentId: string;
  /** The upgrading member: the data key's creator and the grant's signer. */
  createdBy: string;
  /** The `env_data_keys` id every submitted value was sealed against. */
  dataKeyId: string;
  /** The upgrader's own grant on version 1 of the new key. */
  grant: EnvKeyGrantSeed;
  secrets: readonly UpgradedSecret[];
  /** The soft-deleted secrets the person agreed to erase. Must be all of them. */
  eraseSecretIds: readonly string[];
  /** The live keyless tokens the person agreed to revoke. Must be all of them. */
  revokeTokenIds: readonly string[];
  /**
   * Runs last, inside the transaction, once the environment is end-to-end
   * encrypted: the service layer queues the key shares the new key owes, which
   * needs `can()` and therefore cannot be decided here.
   */
  afterUpgrade?: ((tx: Executor) => Promise<void>) | undefined;
}

export interface UpgradeEnvironmentResult {
  dataKey: EnvDataKeyRecord;
  secretCount: number;
  versionCount: number;
  noteCount: number;
  erased: { id: string; name: string }[];
  revoked: { id: string; name: string; tokenPrefix: string }[];
}

/** Why an upgrade was refused. Each is a stable word the service turns into a fixed message. */
export type EncryptionUpgradeRefusal =
  /** The environment is already end-to-end encrypted. */
  | 'already-e2ee'
  /** A live secret, a version or a note changed since the browser read them. */
  | 'stale'
  /** The soft-deleted secrets are not the ones the person agreed to erase. */
  | 'deleted-changed'
  /** The keyless tokens are not the ones the person agreed to revoke. */
  | 'tokens-changed'
  /** A stored row is in a shape a `server`-mode environment cannot hold. */
  | 'inconsistent'
  /**
   * The new key's first grant is not sealed to the upgrader's current vault
   * key: a vault reset landed in between, or the request was built from
   * somebody else's public key. Either way, nobody holding this account's vault
   * could open the key, and every value under it would be lost.
   */
  | 'grant-key'
  /** A note was dropped (a stored note with no sealed one) or invented (the reverse). */
  | 'notes';

export class EncryptionUpgradeConflict extends RepositoryError {
  constructor(readonly refusal: EncryptionUpgradeRefusal) {
    super('conflict', `encryption upgrade refused: ${refusal}`);
    this.name = 'EncryptionUpgradeConflict';
  }
}

/** What an upgrade will do, measured without reading a single value. */
export interface EncryptionUpgradeObligations {
  liveSecretCount: number;
  versionCount: number;
  noteCount: number;
  /**
   * The summed length of every live version's server-envelope ciphertext, and
   * of every non-empty note's UTF-8 — what the upgrade's request body will be
   * built from, measured without decrypting anything (`estimateUpgradeBodyBytes`).
   */
  ciphertextBytes: number;
  noteBytes: number;
  deletedSecrets: { id: string; name: string }[];
  keylessTokens: { id: string; name: string; tokenPrefix: string }[];
}

/**
 * A token that can still authenticate and has nothing the new key could be
 * sealed to — the same liveness predicate `findServiceTokenByHash` uses.
 */
function liveKeylessToken(orgId: string, environmentId: string) {
  return and(
    eq(serviceTokens.orgId, orgId),
    eq(serviceTokens.environmentId, environmentId),
    isNull(serviceTokens.revokedAt),
    or(isNull(serviceTokens.expiresAt), sql`${serviceTokens.expiresAt} > now()`),
    isNull(serviceTokens.publicKey),
  );
}

/**
 * The counts and names an upgrade dialog shows before anybody decides: how much
 * will be re-encrypted, which deleted secrets will be erased, which tokens will
 * stop working. Metadata only — no ciphertext is selected.
 */
export async function loadEncryptionUpgradeObligations(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<EncryptionUpgradeObligations> {
  const scoped = and(
    eq(secrets.environmentId, environmentId),
    eq(projects.orgId, orgId),
    isNull(environments.deletedAt),
    isNull(projects.deletedAt),
  );

  const [live] = await exec
    .select({
      secrets: count(),
      notes: sql<number>`count(${secrets.note}) filter (where ${secrets.note} <> '')`.mapWith(
        Number,
      ),
      noteBytes: sql<number>`coalesce(sum(octet_length(${secrets.note})), 0)`.mapWith(Number),
    })
    .from(secrets)
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(scoped, isNull(secrets.deletedAt)));

  const [history] = await exec
    .select({
      versions: count(),
      ciphertextBytes:
        sql<number>`coalesce(sum(octet_length(${secretVersions.ciphertext})), 0)`.mapWith(Number),
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(scoped, isNull(secrets.deletedAt)));

  const deletedSecrets = await exec
    .select({ id: secrets.id, name: secrets.name })
    .from(secrets)
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(scoped, isNotNull(secrets.deletedAt)))
    .orderBy(secrets.name);

  const keylessTokens = await exec
    .select({
      id: serviceTokens.id,
      name: serviceTokens.name,
      tokenPrefix: serviceTokens.tokenPrefix,
    })
    .from(serviceTokens)
    .where(liveKeylessToken(orgId, environmentId))
    .orderBy(serviceTokens.name);

  return {
    liveSecretCount: live?.secrets ?? 0,
    versionCount: history?.versions ?? 0,
    noteCount: live?.notes ?? 0,
    ciphertextBytes: history?.ciphertextBytes ?? 0,
    noteBytes: live?.noteBytes ?? 0,
    deletedSecrets,
    keylessTokens,
  };
}

/**
 * Performs the upgrade — all of it, or none of it.
 *
 * Throws `EncryptionUpgradeConflict` for every refusal that is about the state
 * of the world rather than the request, and `RepositoryError('notFound')` for
 * an environment that is not there. Anything else that goes wrong — a foreign
 * key the post-conditions did not foresee, a lost connection — rolls the whole
 * transaction back too, which is the property that matters: an environment is
 * either still entirely `server`-mode and readable exactly as before, or
 * entirely end-to-end encrypted.
 */
export async function upgradeEnvironmentEncryption(
  exec: Executor,
  params: UpgradeEnvironmentParams,
): Promise<UpgradeEnvironmentResult> {
  return exec.transaction(async (tx) => {
    // ── 1. Locks, in the order the header gives ──
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, params.orgId), isNull(organizations.deletedAt)))
      .for('share');
    if (!organization) throw new RepositoryError('notFound', 'Organisation not found.');

    // The grant must be sealed to the key this account's vault holds *now*.
    // Checked here, held `FOR SHARE`, rather than trusted from the request: a
    // grant sealed to any other key is a key nobody holding this vault can
    // open, and committing it would delete the only key that still could.
    const [vault] = await tx
      .select({ encPublicKey: userKeys.encPublicKey })
      .from(userKeys)
      .where(eq(userKeys.userId, params.createdBy))
      .limit(1)
      .for('share');
    if (!vault || !bytesEqual(vault.encPublicKey, params.grant.recipientPublicKey)) {
      throw new EncryptionUpgradeConflict('grant-key');
    }

    const [environment] = await tx
      .select({ id: environments.id, encryptionMode: environments.encryptionMode })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(environments.id, params.environmentId),
          eq(projects.orgId, params.orgId),
          isNull(environments.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .for('update', { of: environments });

    if (!environment) {
      throw new RepositoryError('notFound', `Environment ${params.environmentId} not found`);
    }
    // Re-checked here, from the locked row, whatever the route saw: a second
    // tab's upgrade that committed first is refused, not repeated.
    if (environment.encryptionMode !== 'server') {
      throw new EncryptionUpgradeConflict('already-e2ee');
    }

    const stored = await tx
      .select({
        id: secrets.id,
        name: secrets.name,
        note: secrets.note,
        deletedAt: secrets.deletedAt,
        revision: secretRevision(),
      })
      .from(secrets)
      .where(eq(secrets.environmentId, params.environmentId))
      .for('update');

    await tx
      .select({ id: envKeys.id })
      .from(envKeys)
      .where(eq(envKeys.environmentId, params.environmentId))
      .for('update');

    // ── 2. The stored world, read after every lock is held ──
    const versions = await tx
      .select({
        id: secretVersions.id,
        secretId: secretVersions.secretId,
        version: secretVersions.version,
        envKeyId: secretVersions.envKeyId,
      })
      .from(secretVersions)
      .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
      .where(and(eq(secrets.environmentId, params.environmentId), isNull(secrets.deletedAt)));

    const tokens = await tx
      .select({
        id: serviceTokens.id,
        name: serviceTokens.name,
        tokenPrefix: serviceTokens.tokenPrefix,
      })
      .from(serviceTokens)
      .where(liveKeylessToken(params.orgId, params.environmentId));

    // ── 3. The submitted world must be that world, exactly ──
    const live = stored.filter((row) => row.deletedAt === null);
    const deleted = stored.filter((row) => row.deletedAt !== null);

    assertSameSet(
      live.map((row) => row.id),
      params.secrets.map((secret) => secret.id),
      'stale',
    );

    const liveById = new Map(live.map((row) => [row.id, row]));
    const versionsBySecret = new Map<string, Map<string, number>>();
    for (const row of versions) {
      // A version naming no server key in an environment that is still
      // `server`-mode is not a state any write path produces. Refused rather
      // than "upgraded": the browser was never handed it, so whatever it is,
      // this transaction cannot vouch for it.
      if (row.envKeyId === null) throw new EncryptionUpgradeConflict('inconsistent');
      let byId = versionsBySecret.get(row.secretId);
      if (byId === undefined) {
        byId = new Map();
        versionsBySecret.set(row.secretId, byId);
      }
      byId.set(row.id, row.version);
    }

    for (const secret of params.secrets) {
      const row = liveById.get(secret.id);
      if (row === undefined || row.revision !== secret.revision) {
        throw new EncryptionUpgradeConflict('stale');
      }
      // A note travels or it does not exist — never one without the other. A
      // stored note with no sealed one would be erased by this commit; a sealed
      // note for a secret that had none is something the browser made up.
      // `encodeNote` sends nothing for an empty note, so empty counts as none.
      const hasNote = row.note !== null && row.note.length > 0;
      if (hasNote !== (secret.encNote !== null)) {
        throw new EncryptionUpgradeConflict('notes');
      }
      const storedVersions = versionsBySecret.get(secret.id) ?? new Map<string, number>();
      if (storedVersions.size !== secret.versions.length) {
        throw new EncryptionUpgradeConflict('stale');
      }
      for (const version of secret.versions) {
        if (storedVersions.get(version.id) !== version.version) {
          throw new EncryptionUpgradeConflict('stale');
        }
      }
    }

    assertSameSet(
      deleted.map((row) => row.id),
      params.eraseSecretIds,
      'deleted-changed',
    );
    assertSameSet(
      tokens.map((row) => row.id),
      params.revokeTokenIds,
      'tokens-changed',
    );

    // ── 4. The new key, exactly as key initialisation writes it ──
    // The same function the repair endpoint and environment creation use, so
    // the version-1 key, the HMAC key and the self-grant cannot be written any
    // differently here. It refuses an environment that already has a data key.
    const dataKey = await initializeEnvironmentKeys(tx, {
      orgId: params.orgId,
      environmentId: params.environmentId,
      createdBy: params.createdBy,
      grant: params.grant,
      dataKeyId: params.dataKeyId,
    });

    // ── 5. Every version and every note, rewritten in place, set-based ──
    const versionRows = params.secrets.flatMap((secret) =>
      secret.versions.map((version) => ({
        versionId: version.id,
        secretId: secret.id,
        version: version.version,
        ciphertext: version.ciphertext,
        clientAlgorithm: version.clientAlgorithm,
        valueHmac: version.valueHmac,
      })),
    );
    const versionCount = await reencryptVersionsInPlace(tx, dataKey.id, versionRows);
    if (versionCount !== versionRows.length) throw new EncryptionUpgradeConflict('stale');

    const noted = await sealNotesInPlace(
      tx,
      params.environmentId,
      params.secrets.map((secret) => ({ secretId: secret.id, encNote: secret.encNote })),
    );
    if (noted !== params.secrets.length) throw new EncryptionUpgradeConflict('stale');
    const noteCount = params.secrets.filter((secret) => secret.encNote !== null).length;

    // ── 6. What cannot cross ──
    const erased =
      deleted.length === 0
        ? []
        : await tx
            .delete(secrets)
            .where(
              and(
                eq(secrets.environmentId, params.environmentId),
                isNotNull(secrets.deletedAt),
                inArray(
                  secrets.id,
                  deleted.map((row) => row.id),
                ),
              ),
            )
            .returning({ id: secrets.id, name: secrets.name });
    if (erased.length !== deleted.length) throw new EncryptionUpgradeConflict('deleted-changed');

    const revoked =
      tokens.length === 0
        ? []
        : await tx
            .update(serviceTokens)
            .set({ revokedAt: sql`now()` })
            .where(
              and(
                liveKeylessToken(params.orgId, params.environmentId),
                inArray(
                  serviceTokens.id,
                  tokens.map((row) => row.id),
                ),
              ),
            )
            .returning({
              id: serviceTokens.id,
              name: serviceTokens.name,
              tokenPrefix: serviceTokens.tokenPrefix,
            });
    if (revoked.length !== tokens.length) throw new EncryptionUpgradeConflict('tokens-changed');

    // ── 7. The mode, and then the key the server could open ──
    const flipped = await tx
      .update(environments)
      .set({ encryptionMode: 'e2ee', updatedAt: sql`now()` })
      .where(
        and(eq(environments.id, params.environmentId), eq(environments.encryptionMode, 'server')),
      )
      .returning({ id: environments.id });
    if (flipped.length !== 1) throw new EncryptionUpgradeConflict('already-e2ee');

    // `ON DELETE RESTRICT` from `secret_versions.env_key_id` makes this the
    // proof as well as the act: if any row anywhere still named one of these
    // keys, the delete fails and the whole upgrade rolls back.
    await tx.delete(envKeys).where(eq(envKeys.environmentId, params.environmentId));

    // ── 8. Post-conditions, checked rather than assumed ──
    // Both are implied by what ran above. They are asserted anyway, inside the
    // transaction, because the cost of being wrong is an environment that says
    // "end-to-end encrypted" while the server can still read part of it.
    const [leftover] = await tx
      .select({
        serverRows:
          sql<number>`count(*) filter (where ${secretVersions.envKeyId} is not null)`.mapWith(
            Number,
          ),
      })
      .from(secretVersions)
      .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
      .where(eq(secrets.environmentId, params.environmentId));
    const [plaintextNotes] = await tx
      .select({ notes: count() })
      .from(secrets)
      .where(and(eq(secrets.environmentId, params.environmentId), isNotNull(secrets.note)));
    if ((leftover?.serverRows ?? 0) !== 0 || (plaintextNotes?.notes ?? 0) !== 0) {
      throw new EncryptionUpgradeConflict('inconsistent');
    }

    await params.afterUpgrade?.(tx);

    return {
      dataKey,
      secretCount: params.secrets.length,
      versionCount,
      noteCount,
      erased,
      revoked,
    };
  });
}

/** Refuses unless the two id lists name the same set, each id once. */
function assertSameSet(
  stored: readonly string[],
  submitted: readonly string[],
  refusal: EncryptionUpgradeRefusal,
): void {
  const want = new Set(stored);
  const got = new Set(submitted);
  if (got.size !== submitted.length || want.size !== got.size) {
    throw new EncryptionUpgradeConflict(refusal);
  }
  for (const id of got) {
    if (!want.has(id)) throw new EncryptionUpgradeConflict(refusal);
  }
}

/** Constant-time over equal lengths; public keys, so the timing is not the point. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}
