import { and, desc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { envDataKeys, envHmacKeys, envKeyGrants, pendingKeyGrants } from '../schema/env-keys';
import type { GrantRecipientKind } from '../schema/env-keys';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { invitations } from '../schema/tenancy';
import { serviceTokens } from '../schema/tokens';
import { userKeys } from '../schema/vault';
import { isUniqueViolation } from './users';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Environment data keys, HMAC keys, and the sealed grants that share them.
 *
 * ── What this module can and cannot do ──
 * It stores and it reads. It cannot decrypt anything, and no extension of it
 * could: every value that crosses this boundary is either a public identifier —
 * an id, a version number, a user — or the ASCII of an `xk2.…` blob sealed to a
 * public key whose private half this server has never held. There is no key here
 * to extend a code path with. That is the same claim `vault.ts` makes about the
 * user half of the hierarchy, and it is the whole of ADR 0009.
 *
 * ── Three rules, all of them enforced rather than intended ──
 *
 *  1. **Every read is tenant-scoped through `projects`.** `env_data_keys`,
 *     `env_hmac_keys`, `env_key_grants` and `pending_key_grants` all hang off
 *     `environments`, which has no `org_id` of its own — so each query here joins
 *     out to `projects` exactly as `environments.ts` does, and that join *is* the
 *     isolation boundary (threat T2), not a redundant condition.
 *
 *  2. **A rotation is one transaction or none of it.** `rotateEnvDataKey` retires
 *     the old key, inserts the new one, and writes the complete grant set
 *     together. A partial rotation is the worst state this table can be in: an
 *     environment whose active key some principals hold and others do not, where
 *     every subsequent write is readable by a shrinking subset of the team and
 *     nothing anywhere says so.
 *
 *  3. **A pending row and the grant that settles it die together.**
 *     `addEnvKeyGrants` writes the grant and deletes the debt in one transaction,
 *     so the banner cannot outlive the key it was asking for, and a failed write
 *     cannot silently clear it.
 */

/** The active EDK of an environment: identity and version, never bytes. */
export interface EnvDataKeyRecord {
  id: string;
  environmentId: string;
  version: number;
  status: string;
  createdBy: string;
  createdAt: Date;
}

/** One principal's sealed copy of an environment's keys. */
export interface EnvKeyGrantRecord {
  id: string;
  envDataKeyId: string;
  recipientKind: GrantRecipientKind;
  recipientId: string;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
  signature: Uint8Array;
  signedByUserId: string;
  createdAt: Date;
}

/** A principal owed a key, as the pending queue reports it. */
export interface PendingKeyGrantRecord {
  id: string;
  environmentId: string;
  targetUserId: string;
  requestedBy: string;
  createdAt: Date;
}

/**
 * Everything the key endpoint answers in one shape.
 *
 * `currentMaxSecretVersion` is the freshness groundwork ADR 0009 records as a
 * residual risk: a server can serve stale grants or silently omit recent
 * `secret_versions`, and a client cannot detect it from signatures alone, which
 * prove origin rather than recency. Returning the environment's highest version
 * on every key read means a client-side monotonic counter can be added later
 * without an API change — which is exactly what the plan asks for and exactly as
 * far as it goes. **Nothing on the server enforces it**; a compromised server
 * would simply report a lower number, and saying otherwise here would be worse
 * than saying nothing.
 */
export interface EnvironmentKeyState {
  activeKey: EnvDataKeyRecord | null;
  ehkExists: boolean;
  currentMaxSecretVersion: number;
}

/** The material one sealed grant is written from. Blobs, verbatim. */
export interface EnvKeyGrantSeed {
  recipientKind: GrantRecipientKind;
  recipientId: string;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
  signature: Uint8Array;
}

const DATA_KEY_COLUMNS = {
  id: envDataKeys.id,
  environmentId: envDataKeys.environmentId,
  version: envDataKeys.version,
  status: envDataKeys.status,
  createdBy: envDataKeys.createdBy,
  createdAt: envDataKeys.createdAt,
} as const;

const GRANT_COLUMNS = {
  id: envKeyGrants.id,
  envDataKeyId: envKeyGrants.envDataKeyId,
  memberUserId: envKeyGrants.memberUserId,
  serviceTokenId: envKeyGrants.serviceTokenId,
  invitationId: envKeyGrants.invitationId,
  edkSealed: envKeyGrants.edkSealed,
  ehkSealed: envKeyGrants.ehkSealed,
  signature: envKeyGrants.signature,
  signedByUserId: envKeyGrants.signedByUserId,
  createdAt: envKeyGrants.createdAt,
} as const;

/**
 * The `org_id` predicate for statements whose target is an environment-scoped
 * key table.
 *
 * `environments` cannot express "belongs to this organisation", so the reach out
 * to `projects` becomes a correlated `EXISTS`. Any statement in this file that
 * touches one of the four tables and does not carry this — or an equivalent join
 * — is not tenant-scoped, and that is the only thing standing between an
 * environment id from a URL and another tenant's sealed grants.
 */
function environmentWithinOrganization(orgId: string, environmentId: string) {
  return sql`exists (
    select 1 from ${environments}
    inner join ${projects} on ${projects.id} = ${environments.projectId}
    where ${environments.id} = ${environmentId}
      and ${projects.orgId} = ${orgId}
      and ${environments.deletedAt} is null
      and ${projects.deletedAt} is null
  )`;
}

/**
 * Reads the environment's key state: the active EDK, whether an EHK exists, and
 * the highest secret version currently stored.
 *
 * Three statements rather than one join, because the three answers have nothing
 * to do with each other: joining an aggregate over `secret_versions` onto a
 * single-row key lookup would make the cheap question pay for the expensive one
 * on every dashboard navigation.
 */
export async function loadEnvironmentKeyState(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<EnvironmentKeyState> {
  const [activeKey] = await exec
    .select(DATA_KEY_COLUMNS)
    .from(envDataKeys)
    .where(
      and(
        eq(envDataKeys.environmentId, environmentId),
        eq(envDataKeys.status, 'active'),
        environmentWithinOrganization(orgId, environmentId),
      ),
    )
    // Ordered rather than trusting that exactly one row is active: an
    // interrupted rotation could in principle leave two, and picking the newest
    // is the behaviour that keeps the environment usable while it is sorted out.
    // The partial unique index is what makes that hypothetical.
    .orderBy(desc(envDataKeys.version))
    .limit(1);

  const [hmac] = await exec
    .select({ id: envHmacKeys.id })
    .from(envHmacKeys)
    .where(
      and(
        eq(envHmacKeys.environmentId, environmentId),
        environmentWithinOrganization(orgId, environmentId),
      ),
    )
    .limit(1);

  const [highest] = await exec
    .select({ version: max(secretVersions.version) })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secrets.environmentId, environmentId),
        eq(projects.orgId, orgId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    );

  return {
    activeKey: activeKey ?? null,
    ehkExists: hmac !== undefined,
    currentMaxSecretVersion: highest?.version ?? 0,
  };
}

export interface InitializeEnvironmentKeysParams {
  orgId: string;
  environmentId: string;
  createdBy: string;
  /** The creator's own grant. An environment key nobody holds is unusable. */
  grant: EnvKeyGrantSeed;
}

/**
 * Creates version 1 of an environment's EDK, its EHK, and the creator's own
 * grant — all three, or none.
 *
 * The transaction is the point, and each pair of the three explains why. Keys
 * without a grant are an environment nobody — including the person who just
 * created it — can ever read, and no repair exists on the request path, because
 * producing a grant needs the key bytes and they only ever existed in the
 * browser that has now navigated away. A grant without keys references nothing. An
 * EDK without an EHK leaves `valueHmac` underivable, so no-op detection silently
 * stops working on the first write.
 *
 * Initialising over an existing key is a **conflict, never an overwrite**, for
 * the same reason `createVault` refuses to replace a vault: the existing key has
 * values encrypted under it, and silently replacing it would make every one of
 * them unreadable while reporting success.
 */
export async function initializeEnvironmentKeys(
  exec: Executor,
  params: InitializeEnvironmentKeysParams,
): Promise<EnvDataKeyRecord> {
  const now = new Date();
  const dataKeyId = uuidv7();

  try {
    return await exec.transaction(async (tx) => {
      await requireEnvironment(tx, params.orgId, params.environmentId);

      const [existing] = await tx
        .select({ id: envDataKeys.id })
        .from(envDataKeys)
        .where(eq(envDataKeys.environmentId, params.environmentId))
        .limit(1);

      if (existing) {
        throw new RepositoryError('conflict', 'This environment already has a data key.');
      }

      const [dataKey] = await tx
        .insert(envDataKeys)
        .values({
          id: dataKeyId,
          environmentId: params.environmentId,
          version: 1,
          status: 'active',
          createdBy: params.createdBy,
          createdAt: now,
        })
        .returning(DATA_KEY_COLUMNS);

      if (!dataKey) {
        // Unreachable: an INSERT … RETURNING that inserted a row returns it. A
        // throw rather than a non-null assertion, so a future ON CONFLICT clause
        // fails loudly instead of returning a fabricated row.
        throw new RepositoryError('conflict', 'Failed to create the environment data key.');
      }

      await tx.insert(envHmacKeys).values({
        id: uuidv7(),
        environmentId: params.environmentId,
        createdBy: params.createdBy,
        createdAt: now,
      });

      await tx
        .insert(envKeyGrants)
        .values(grantRow(dataKeyId, params.createdBy, params.grant, now));

      return dataKey;
    });
  } catch (cause) {
    throw asKeyConflict(cause);
  }
}

export interface RotateEnvDataKeyParams {
  orgId: string;
  environmentId: string;
  createdBy: string;
  /** The version the client generated. Checked against the stored one. */
  version: number;
  /** The **complete** replacement set, for every principal that keeps access. */
  grants: readonly EnvKeyGrantSeed[];
}

/**
 * Retires the active key, writes the next version, and seals it to everyone —
 * in one transaction.
 *
 * ── Why the version is supplied rather than computed ──
 * The client has already sealed every grant, and each sealed blob binds
 * `edkVersion` into its AAD (spec §4.2). If this function assigned the number
 * itself, a rotation racing another would produce grants whose AAD names version
 * 4 stored against a row numbered 5 — every one of which would fail to open, for
 * ever, with no error at write time. So the client states the version it sealed
 * for and this checks it: a mismatch is a conflict the client retries after
 * re-reading, which is the only outcome that cannot corrupt anything.
 *
 * ── Why the old row is retired rather than deleted ──
 * Every `secret_versions` row written under it still references it, and the FK is
 * `restrict` precisely so that this is not a decision a future edit can make by
 * accident. Retiring it takes it out of the write path; the values it protects
 * stay readable to anyone who still holds an old grant, which is the correct
 * outcome — a member removed today did not stop having seen yesterday's values.
 *
 * ── What this does not do ──
 * It does not decide *who* should be in the grant set. Completeness against the
 * authorization model is the service layer's question, because it needs
 * `can()`, and this layer does not import the policy engine (see
 * `membership.ts` for the same seam).
 */
export async function rotateEnvDataKey(
  exec: Executor,
  params: RotateEnvDataKeyParams,
): Promise<EnvDataKeyRecord> {
  const now = new Date();
  const dataKeyId = uuidv7();

  try {
    return await exec.transaction(async (tx) => {
      await requireEnvironment(tx, params.orgId, params.environmentId);

      const [current] = await tx
        .select({ id: envDataKeys.id, version: envDataKeys.version })
        .from(envDataKeys)
        .where(
          and(
            eq(envDataKeys.environmentId, params.environmentId),
            eq(envDataKeys.status, 'active'),
          ),
        )
        .orderBy(desc(envDataKeys.version))
        .limit(1)
        // Serialises two rotations of one environment. Without it both read the
        // same active row, both retire it, and both insert — one of them losing
        // to `env_data_keys_active_unique` after having already written a full
        // grant set, which is a wasted round trip at best and, if the index were
        // ever relaxed, two live keys at worst.
        .for('update');

      if (!current) {
        throw new RepositoryError('notFound', 'This environment has no active data key to rotate.');
      }

      if (params.version !== current.version + 1) {
        throw new RepositoryError(
          'conflict',
          'This environment was rotated by another request. Re-read its keys and try again.',
        );
      }

      await tx.update(envDataKeys).set({ status: 'retired' }).where(eq(envDataKeys.id, current.id));

      const [dataKey] = await tx
        .insert(envDataKeys)
        .values({
          id: dataKeyId,
          environmentId: params.environmentId,
          version: params.version,
          status: 'active',
          createdBy: params.createdBy,
          createdAt: now,
        })
        .returning(DATA_KEY_COLUMNS);

      if (!dataKey) {
        throw new RepositoryError('conflict', 'Failed to create the rotated environment key.');
      }

      await tx
        .insert(envKeyGrants)
        .values(params.grants.map((seed) => grantRow(dataKeyId, params.createdBy, seed, now)));

      // A rotation settles every debt on this environment: the new key has just
      // been sealed to everyone entitled to it, so anything still queued is a
      // request that has already been answered.
      await tx
        .delete(pendingKeyGrants)
        .where(eq(pendingKeyGrants.environmentId, params.environmentId));

      return dataKey;
    });
  } catch (cause) {
    throw asKeyConflict(cause);
  }
}

export interface AddEnvKeyGrantsParams {
  orgId: string;
  environmentId: string;
  envDataKeyId: string;
  signedByUserId: string;
  grants: readonly EnvKeyGrantSeed[];
}

/**
 * Adds grants for principals that did not have one, against the **active** key.
 *
 * The key id is supplied by the caller and re-checked here against the active
 * row, rather than resolved fresh: the client sealed for a specific version, and
 * accepting a grant sealed for a key that has since been rotated away would store
 * a blob nobody can open — the same failure mode `rotateEnvDataKey` guards, from
 * the other side.
 *
 * A duplicate is a **conflict**, decided by the partial unique indexes rather
 * than by a `SELECT` beforehand. Check-then-insert is not a weaker guarantee
 * here, it is no guarantee at all: two admins fulfilling one pending row from two
 * browsers both read "absent", and only the index has ever stopped them.
 */
export async function addEnvKeyGrants(
  exec: Executor,
  params: AddEnvKeyGrantsParams,
): Promise<number> {
  const now = new Date();

  try {
    return await exec.transaction(async (tx) => {
      await requireEnvironment(tx, params.orgId, params.environmentId);
      await requireActiveKey(tx, params.environmentId, params.envDataKeyId);

      const rows = await tx
        .insert(envKeyGrants)
        .values(
          params.grants.map((seed) =>
            grantRow(params.envDataKeyId, params.signedByUserId, seed, now),
          ),
        )
        .returning({ id: envKeyGrants.id });

      // Every member grant written here answers a debt, if one was recorded.
      // Deleting it in the same transaction is what stops the banner outliving
      // the key it was asking for.
      const fulfilled = params.grants
        .filter((seed) => seed.recipientKind === 'member')
        .map((seed) => seed.recipientId);

      if (fulfilled.length > 0) {
        await tx
          .delete(pendingKeyGrants)
          .where(
            and(
              eq(pendingKeyGrants.environmentId, params.environmentId),
              inArray(pendingKeyGrants.targetUserId, fulfilled),
            ),
          );
      }

      return rows.length;
    });
  } catch (cause) {
    throw asKeyConflict(cause);
  }
}

/**
 * One principal's grant on an environment's active key, or `null`.
 *
 * This is what the dashboard reads on every environment open, so it is one
 * statement: the join to `env_data_keys` filters to the active version, and the
 * join out to `projects` is the tenancy predicate.
 */
export async function findGrantForPrincipal(
  exec: Executor,
  params: {
    orgId: string;
    environmentId: string;
    recipientKind: GrantRecipientKind;
    recipientId: string;
  },
): Promise<EnvKeyGrantRecord | null> {
  const [row] = await exec
    .select(GRANT_COLUMNS)
    .from(envKeyGrants)
    .innerJoin(
      envDataKeys,
      and(
        eq(envDataKeys.id, envKeyGrants.envDataKeyId),
        eq(envDataKeys.environmentId, params.environmentId),
        eq(envDataKeys.status, 'active'),
      ),
    )
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(projects.orgId, params.orgId), recipientPredicate(params)))
    .limit(1);

  return row ? toGrantRecord(row) : null;
}

/** Every grant on an environment's active key. The rotation preview reads this. */
export async function listGrantsForEnvironment(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<EnvKeyGrantRecord[]> {
  const rows = await exec
    .select(GRANT_COLUMNS)
    .from(envKeyGrants)
    .innerJoin(
      envDataKeys,
      and(
        eq(envDataKeys.id, envKeyGrants.envDataKeyId),
        eq(envDataKeys.environmentId, environmentId),
        eq(envDataKeys.status, 'active'),
      ),
    )
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(projects.orgId, orgId))
    .orderBy(envKeyGrants.createdAt);

  return rows.map(toGrantRecord);
}

/**
 * Removes one grant, by id, scoped to the environment it must belong to.
 *
 * Scoped by environment as well as by id so one tenant cannot delete another's
 * grant by guessing a uuid (threat T2), exactly as `removePasskey` is scoped by
 * user. Returns whether a row went, so the caller answers "no such grant" rather
 * than reporting a revocation that did not happen.
 *
 * **Removing a grant does not make anything unreadable.** The principal read the
 * values while they held it, and the sealed blob was in a browser that may have
 * kept the key. That is what makes the rotation that follows the security control
 * and this the bookkeeping — see `needsRotation` in the service layer.
 */
export async function removeEnvKeyGrant(
  exec: Executor,
  params: { orgId: string; environmentId: string; grantId: string },
): Promise<EnvKeyGrantRecord | null> {
  const [existing] = await exec
    .select(GRANT_COLUMNS)
    .from(envKeyGrants)
    .innerJoin(
      envDataKeys,
      and(
        eq(envDataKeys.id, envKeyGrants.envDataKeyId),
        eq(envDataKeys.environmentId, params.environmentId),
      ),
    )
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(envKeyGrants.id, params.grantId), eq(projects.orgId, params.orgId)))
    .limit(1);

  if (!existing) return null;

  await exec.delete(envKeyGrants).where(eq(envKeyGrants.id, params.grantId));

  return toGrantRecord(existing);
}

/**
 * Deletes every grant a member holds in one environment.
 *
 * The revocation path: access was narrowed or removed, so the rows go. Across
 * *every* key version rather than only the active one, because an old grant is
 * still an old key, and leaving it would mean a re-invited member silently
 * regained the ability to read the history they were removed from.
 */
export async function removeMemberGrantsForEnvironment(
  exec: Executor,
  params: { orgId: string; environmentId: string; userId: string },
): Promise<number> {
  // The key versions are resolved first, under the tenancy predicate, and the
  // delete then names them explicitly. Written as two statements rather than one
  // correlated subquery because the predicate is the isolation boundary: with the
  // ids in hand, the delete cannot reach a row outside the environment this
  // caller was authorised for, whatever a later edit does to the second statement.
  const versions = await exec
    .select({ id: envDataKeys.id })
    .from(envDataKeys)
    .where(
      and(
        eq(envDataKeys.environmentId, params.environmentId),
        environmentWithinOrganization(params.orgId, params.environmentId),
      ),
    );

  if (versions.length === 0) return 0;

  const rows = await exec
    .delete(envKeyGrants)
    .where(
      and(
        eq(envKeyGrants.memberUserId, params.userId),
        inArray(
          envKeyGrants.envDataKeyId,
          versions.map((version) => version.id),
        ),
      ),
    )
    .returning({ id: envKeyGrants.id });

  return rows.length;
}

/**
 * Deletes every grant and every queued debt belonging to one account.
 *
 * Called by the vault reset. Each row is an EDK and an EHK sealed to a public key
 * that no longer exists, so they are ciphertext addressed to a principal with no
 * private key — and leaving them would make a re-invitation look like it had
 * nothing to do, because a grant row would already exist for the member.
 */
export async function deleteGrantsForUser(exec: Executor, userId: string): Promise<number> {
  const removed = await exec
    .delete(envKeyGrants)
    .where(eq(envKeyGrants.memberUserId, userId))
    .returning({ id: envKeyGrants.id });

  await exec.delete(pendingKeyGrants).where(eq(pendingKeyGrants.targetUserId, userId));

  return removed.length;
}

/**
 * Records that a principal is owed a key on an environment.
 *
 * Idempotent by `ON CONFLICT DO NOTHING` against `pending_key_grants_unique`:
 * widening someone's access twice before anybody fulfils the first request owes
 * the same single key, and a second row would list the same person twice in the
 * banner. Returns whether a new debt was recorded, so the caller can decide
 * whether the act is worth an audit record.
 */
export async function queuePendingKeyGrant(
  exec: Executor,
  params: { environmentId: string; targetUserId: string; requestedBy: string },
): Promise<boolean> {
  const rows = await exec
    .insert(pendingKeyGrants)
    .values({
      id: uuidv7(),
      environmentId: params.environmentId,
      targetUserId: params.targetUserId,
      requestedBy: params.requestedBy,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: pendingKeyGrants.id });

  return rows.length > 0;
}

/** The queue for one environment. Ids and timestamps; nothing sealed, nothing secret. */
export async function listPendingKeyGrants(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<PendingKeyGrantRecord[]> {
  return exec
    .select({
      id: pendingKeyGrants.id,
      environmentId: pendingKeyGrants.environmentId,
      targetUserId: pendingKeyGrants.targetUserId,
      requestedBy: pendingKeyGrants.requestedBy,
      createdAt: pendingKeyGrants.createdAt,
    })
    .from(pendingKeyGrants)
    .innerJoin(environments, eq(environments.id, pendingKeyGrants.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(pendingKeyGrants.environmentId, environmentId), eq(projects.orgId, orgId)))
    .orderBy(pendingKeyGrants.createdAt);
}

/**
 * Which environments a member already holds a key for, and which they are owed
 * one in — across the whole organisation, in two statements.
 *
 * Exists for the reconciliation that runs after every membership change. Doing
 * it per environment would be two queries per environment on a page whose whole
 * job is to change one person's access across all of them, and the answer is
 * only meaningful as a set anyway: what the caller wants to know is the
 * *difference* between where the person can read and where they hold a key.
 *
 * Only the **active** key counts as "granted". A member holding a grant on a
 * retired version can read history and nothing written since, which is precisely
 * the state a pending share exists to resolve rather than to hide.
 */
export async function loadMemberKeyPresence(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<{ granted: Set<string>; pending: Set<string> }> {
  const granted = await exec
    .select({ environmentId: envDataKeys.environmentId })
    .from(envKeyGrants)
    .innerJoin(
      envDataKeys,
      and(eq(envDataKeys.id, envKeyGrants.envDataKeyId), eq(envDataKeys.status, 'active')),
    )
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(envKeyGrants.memberUserId, userId), eq(projects.orgId, orgId)));

  const pending = await exec
    .select({ environmentId: pendingKeyGrants.environmentId })
    .from(pendingKeyGrants)
    .innerJoin(environments, eq(environments.id, pendingKeyGrants.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(pendingKeyGrants.targetUserId, userId), eq(projects.orgId, orgId)));

  return {
    granted: new Set(granted.map((row) => row.environmentId)),
    pending: new Set(pending.map((row) => row.environmentId)),
  };
}

/** Drops a queued debt without fulfilling it — the member lost the access again. */
export async function removePendingKeyGrant(
  exec: Executor,
  params: { environmentId: string; targetUserId: string },
): Promise<boolean> {
  const rows = await exec
    .delete(pendingKeyGrants)
    .where(
      and(
        eq(pendingKeyGrants.environmentId, params.environmentId),
        eq(pendingKeyGrants.targetUserId, params.targetUserId),
      ),
    )
    .returning({ id: pendingKeyGrants.id });

  return rows.length > 0;
}

/**
 * Every service token in an environment that can be sealed to.
 *
 * Revoked tokens are excluded, and so are tokens with no public key: a token
 * minted before the Phase 4 creation flow has no keypair, so there is nothing to
 * seal to and a rotation must not be blocked waiting for one. The service layer
 * uses this to decide the required grant set, so what is filtered here is
 * precisely what a rotation is not required to cover.
 */
export async function listSealableServiceTokens(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<{ id: string; publicKey: Uint8Array }[]> {
  const rows = await exec
    .select({ id: serviceTokens.id, publicKey: serviceTokens.publicKey })
    .from(serviceTokens)
    .where(
      and(
        eq(serviceTokens.orgId, orgId),
        eq(serviceTokens.environmentId, environmentId),
        isNull(serviceTokens.revokedAt),
        isNotNull(serviceTokens.publicKey),
      ),
    );

  return rows.flatMap((row) => (row.publicKey ? [{ id: row.id, publicKey: row.publicKey }] : []));
}

/**
 * One open invitation of this organisation, or `null`.
 *
 * Exists so a key grant can be checked against the invitation it names.
 * Tenant-scoped and state-scoped in one predicate: an invitation belonging to
 * another organisation, one already accepted, and one revoked all come back the
 * same way, because the caller is entitled to the same answer for all three —
 * "that invitation cannot hold a key here".
 */
export async function findPendingInvitationForGrant(
  exec: Executor,
  orgId: string,
  invitationId: string,
): Promise<{ id: string } | null> {
  const [row] = await exec
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Records the invitation's public key, so grants can be sealed to it. */
export async function setInvitationPublicKey(
  exec: Executor,
  params: { invitationId: string; publicKey: Uint8Array },
): Promise<void> {
  await exec
    .update(invitations)
    .set({ invitePublicKey: params.publicKey })
    .where(eq(invitations.id, params.invitationId));
}

/** A member's public halves, as a client needs them in order to seal. */
export interface MemberSealingKeys {
  userId: string;
  /** The 32-byte X25519 key a grant is sealed to. */
  encPublicKey: Uint8Array;
  /** The 32-byte Ed25519 key a grant signature will one day verify against. */
  signPublicKey: Uint8Array;
}

/**
 * The public keys of the members a client is about to seal to.
 *
 * ── Why the server has to answer this at all ──
 * Sealing is asymmetric: producing a grant for somebody requires *their* public
 * key, and a browser has no other way to learn one. Rotation, the pending-share
 * queue and an admin widening access all fail closed without this — not with an
 * error, but by being impossible to attempt.
 *
 * Nothing secret crosses the boundary. Both columns are stored in the clear
 * precisely because they are public (`schema/vault.ts` says so on the columns
 * themselves), and a public key confers no reach: it lets the holder *give* a
 * key away, never take one.
 *
 * A user with no vault has no row and is simply absent from the answer. That is
 * the honest shape — there is nothing to seal to — and it is what lets the
 * caller name them in a "these people cannot be given a key yet" message instead
 * of failing the whole rotation.
 */
export async function listMemberSealingKeys(
  exec: Executor,
  userIds: readonly string[],
): Promise<MemberSealingKeys[]> {
  if (userIds.length === 0) return [];

  return exec
    .select({
      userId: userKeys.userId,
      encPublicKey: userKeys.encPublicKey,
      signPublicKey: userKeys.signPublicKey,
    })
    .from(userKeys)
    .where(inArray(userKeys.userId, [...userIds]));
}

/**
 * One invitation-sealed grant, with everything the invitee needs to open it.
 *
 * `edkVersion` and `environmentId` are the AAD components (spec §4.2); the two
 * slugs are how the client addresses the route it re-uploads to. All four are
 * carried because the invitee holds no other view of this organisation at the
 * moment they run this — they have just joined.
 */
export interface InvitationGrantRecord {
  environmentId: string;
  projectSlug: string;
  environmentSlug: string;
  envDataKeyId: string;
  edkVersion: number;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
}

/**
 * Reads an invitation's sealed grants and deletes them, in one transaction.
 *
 * ── Why read and delete are one act ──
 * The invitation's private key exists only inside a fragment that travelled over
 * a chat message, and the fragment does not expire the way the token does. A row
 * left behind is a copy of the environment's keys addressed to a credential that
 * is now sitting in somebody's message history for ever. Consuming them at
 * acceptance is what bounds that window to the acceptance itself.
 *
 * ── Why losing them is survivable ──
 * If the client crashes between this returning and the re-sealed grants being
 * uploaded, the invitee holds no key — and the pending-share queue, written by
 * the same acceptance, already says exactly that. A teammate fulfils it. The
 * alternative, keeping the rows until a re-seal succeeds, buys one retry at the
 * cost of leaving a fragment-openable key in the database indefinitely.
 *
 * Only grants on **active** data keys are returned: one sealed against a
 * rotated-away key opens a key nothing is written under any more, and handing it
 * to a client that would faithfully re-seal it produces a grant that looks
 * exactly like a working one. The stale rows are deleted all the same.
 */
export async function takeInvitationGrants(
  exec: Executor,
  params: { orgId: string; invitationId: string },
): Promise<InvitationGrantRecord[]> {
  return exec.transaction(async (tx) => {
    const rows = await tx
      .select({
        grantId: envKeyGrants.id,
        environmentId: envDataKeys.environmentId,
        projectSlug: projects.slug,
        environmentSlug: environments.slug,
        envDataKeyId: envDataKeys.id,
        edkVersion: envDataKeys.version,
        edkSealed: envKeyGrants.edkSealed,
        ehkSealed: envKeyGrants.ehkSealed,
        status: envDataKeys.status,
      })
      .from(envKeyGrants)
      .innerJoin(envDataKeys, eq(envDataKeys.id, envKeyGrants.envDataKeyId))
      .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(eq(envKeyGrants.invitationId, params.invitationId), eq(projects.orgId, params.orgId)),
      );

    if (rows.length === 0) return [];

    await tx.delete(envKeyGrants).where(eq(envKeyGrants.invitationId, params.invitationId));

    return rows
      .filter((row) => row.status === 'active')
      .map((row) => ({
        environmentId: row.environmentId,
        projectSlug: row.projectSlug,
        environmentSlug: row.environmentSlug,
        envDataKeyId: row.envDataKeyId,
        edkVersion: row.edkVersion,
        edkSealed: row.edkSealed,
        ehkSealed: row.ehkSealed,
      }));
  });
}

function grantRow(
  envDataKeyId: string,
  signedByUserId: string,
  seed: EnvKeyGrantSeed,
  now: Date,
): typeof envKeyGrants.$inferInsert {
  return {
    id: uuidv7(),
    envDataKeyId,
    memberUserId: seed.recipientKind === 'member' ? seed.recipientId : null,
    serviceTokenId: seed.recipientKind === 'token' ? seed.recipientId : null,
    invitationId: seed.recipientKind === 'invite' ? seed.recipientId : null,
    edkSealed: seed.edkSealed,
    ehkSealed: seed.ehkSealed,
    signature: seed.signature,
    signedByUserId,
    createdAt: now,
  };
}

function recipientPredicate(params: { recipientKind: GrantRecipientKind; recipientId: string }) {
  switch (params.recipientKind) {
    case 'member':
      return eq(envKeyGrants.memberUserId, params.recipientId);
    case 'token':
      return eq(envKeyGrants.serviceTokenId, params.recipientId);
    case 'invite':
      return eq(envKeyGrants.invitationId, params.recipientId);
  }
}

interface GrantRow {
  id: string;
  envDataKeyId: string;
  memberUserId: string | null;
  serviceTokenId: string | null;
  invitationId: string | null;
  edkSealed: Uint8Array;
  ehkSealed: Uint8Array;
  signature: Uint8Array;
  signedByUserId: string;
  createdAt: Date;
}

/**
 * Collapses the three principal columns into a kind and an id.
 *
 * The CHECK guarantees exactly one is set, so the fallthrough is unreachable —
 * and it throws rather than defaulting, because a row that reached this branch
 * has violated a database constraint, and inventing a principal for it would
 * hand a client a grant addressed to somebody the row does not name.
 */
function toGrantRecord(row: GrantRow): EnvKeyGrantRecord {
  const { memberUserId, serviceTokenId, invitationId, ...rest } = row;

  const recipient: { kind: GrantRecipientKind; id: string } | null =
    memberUserId !== null
      ? { kind: 'member', id: memberUserId }
      : serviceTokenId !== null
        ? { kind: 'token', id: serviceTokenId }
        : invitationId !== null
          ? { kind: 'invite', id: invitationId }
          : null;

  if (recipient === null) {
    throw new RepositoryError('invalid', 'A key grant names no principal.');
  }

  return { ...rest, recipientKind: recipient.kind, recipientId: recipient.id };
}

/** Tenancy, resolved before anything is written into an environment. */
async function requireEnvironment(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<void> {
  const [row] = await exec
    .select({ id: environments.id })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(projects.orgId, orgId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new RepositoryError(
      'notFound',
      `Environment ${environmentId} not found in organisation ${orgId}`,
    );
  }
}

/**
 * Confirms the key a grant was sealed for is still the active one.
 *
 * The whole reason this check exists: a grant sealed against a version that has
 * since been rotated away is a blob whose AAD names a key nobody uses, and it
 * would sit in the table looking exactly like a working grant.
 */
async function requireActiveKey(
  exec: Executor,
  environmentId: string,
  envDataKeyId: string,
): Promise<void> {
  const [row] = await exec
    .select({ id: envDataKeys.id })
    .from(envDataKeys)
    .where(
      and(
        eq(envDataKeys.id, envDataKeyId),
        eq(envDataKeys.environmentId, environmentId),
        eq(envDataKeys.status, 'active'),
      ),
    )
    .limit(1);

  if (!row) {
    throw new RepositoryError(
      'conflict',
      'That environment key is no longer the active one. Re-read its keys and try again.',
    );
  }
}

/**
 * Turns a lost race on one of this module's unique constraints into a conflict
 * the caller can explain, and leaves everything else exactly as thrown.
 *
 * `RepositoryError`s raised inside a transaction pass through untouched: they
 * already carry the precise code, and re-wrapping would flatten "already has a
 * key" and "rotated by another request" into one message.
 */
function asKeyConflict(cause: unknown): unknown {
  if (cause instanceof RepositoryError) return cause;

  if (
    isUniqueViolation(cause, 'env_data_keys_active_unique') ||
    isUniqueViolation(cause, 'env_data_keys_environment_version_unique')
  ) {
    return new RepositoryError(
      'conflict',
      'This environment was rotated by another request. Re-read its keys and try again.',
    );
  }

  if (
    isUniqueViolation(cause, 'env_key_grants_member_unique') ||
    isUniqueViolation(cause, 'env_key_grants_token_unique') ||
    isUniqueViolation(cause, 'env_key_grants_invitation_unique')
  ) {
    return new RepositoryError('conflict', 'That principal already holds a grant on this key.');
  }

  if (isUniqueViolation(cause, 'env_hmac_keys_environment_unique')) {
    return new RepositoryError('conflict', 'This environment already has an HMAC key.');
  }

  return cause;
}
