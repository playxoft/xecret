import { and, desc, eq, inArray, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { lockOrganization } from './membership';
import { envDataKeys, envHmacKeys, envKeyGrants, pendingKeyGrants } from '../schema/env-keys';
import type { GrantRecipientKind } from '../schema/env-keys';
import type { OrgRole } from '@xecret/core/authz';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { invitations, organizations } from '../schema/tenancy';
import type { InvitationGrantSeed } from '../schema/tenancy';
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
  /** The 32-byte X25519 key sealed to, as the client stated it at creation. */
  recipientPublicKey: Uint8Array;
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
  /** 32 raw bytes: the X25519 key the blobs were sealed to, which the signature binds. */
  recipientPublicKey: Uint8Array;
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
  recipientPublicKey: envKeyGrants.recipientPublicKey,
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
  /**
   * Re-checks the grant set against the authorization model, **inside** the
   * transaction and under the organisation lock.
   *
   * ── Why this is a callback rather than a check in the caller ──
   * Deciding who must appear in a rotation needs `can()`, and this layer does not
   * import the policy engine (see `membership.ts` for the same seam). But the
   * decision is only sound while nothing can change underneath it: a check that
   * ran before the transaction opened would be re-answering a question that a
   * concurrent member removal had already invalidated, and the rotation would
   * seal the new key to somebody who had just lost access — silently, and
   * audited as a success.
   *
   * So the policy stays with the caller and the *moment* comes from here. The
   * callback is handed this transaction's executor and must throw to abort.
   */
  assertGrantSet: (tx: Executor) => Promise<void>;
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
 * `membership.ts` for the same seam). What it *does* own is **when** that
 * question is asked: `assertGrantSet` runs inside this transaction, under the
 * organisation lock, so the answer cannot have gone stale by the time the grants
 * are written.
 *
 * ── The organisation lock, and why it is not the environment row ──
 * "Who must hold this key" is a question about the *set* of members and their
 * access grants, and no environment row is touched when somebody is removed from
 * an organisation or has a grant revoked. Locking the environment would serialise
 * two rotations — which the `FOR UPDATE` on the active key already does — and
 * nothing else. The organisation row is where membership changes and grant
 * changes already serialise (`lockOrganization`), so it is the only lock that
 * closes the window this function's completeness check exists to cover.
 */
export async function rotateEnvDataKey(
  exec: Executor,
  params: RotateEnvDataKeyParams,
): Promise<EnvDataKeyRecord> {
  const now = new Date();
  const dataKeyId = uuidv7();

  try {
    return await exec.transaction(async (tx) => {
      // Tenancy first, as every write in this file does — the caller's org and
      // environment ids are resolved together before anything else is read.
      await requireEnvironment(tx, params.orgId, params.environmentId);

      // Then the organisation's write lock, before the grant set is judged.
      // Every write whose correctness depends on the membership *set* queues
      // behind this in one order, which is what makes the recomputation below
      // trustworthy rather than merely recent.
      await lockOrganization(tx, params.orgId);

      // Re-derived here, not merely re-used from before the transaction opened.
      // A member removed between a pre-flight check and this commit would
      // otherwise be handed the brand-new key by the very act that exists to
      // take the old one away from them.
      await params.assertGrantSet(tx);

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

      // A rotation settles the debts it actually paid — and only those.
      //
      // Deleting every queued row for the environment would look equivalent and
      // is not: a debt recorded *after* the completeness check ran (an admin
      // widening somebody's access in another tab) names a person this rotation
      // did not seal to, and clearing it would erase the only record that they
      // are owed a key. They would then hold no grant, appear in no banner, and
      // see a list of secret names they cannot decrypt with nothing anywhere
      // saying why. So the delete names the members this set granted.
      const settled = params.grants
        .filter((seed) => seed.recipientKind === 'member')
        .map((seed) => seed.recipientId);

      if (settled.length > 0) {
        await tx
          .delete(pendingKeyGrants)
          .where(
            and(
              eq(pendingKeyGrants.environmentId, params.environmentId),
              inArray(pendingKeyGrants.targetUserId, settled),
            ),
          );
      }

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
  /**
   * An invitation whose grants on **this environment** this write consumes.
   *
   * Set by the invite key step, which is doing exactly one thing: turning a blob
   * addressed to a one-off keypair into a blob addressed to the invitee's own.
   * The caller has already checked that this account accepted that invitation
   * (`canClaimInvitationGrants`); this parameter is what makes the two halves —
   * store the new grant, destroy the old one — a single transaction rather than
   * two requests with a failure mode between them.
   *
   * Per environment, not per invitation, and that is the whole reason a retry
   * works: an invitee whose second environment fails to re-seal keeps its invite
   * grant and can claim it later, while the first stays claimed.
   */
  claimInvitationId?: string | null;
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

      // The invitation's copy dies with the write that replaces it.
      //
      // Ordering is the point. The invite grant is the *only* copy of this
      // environment's key the invitee can reach until their own grant exists, so
      // deleting it before the insert commits — which is what acceptance used to
      // do — turns any failure after that moment into a permanent loss. Deleting
      // it inside the same transaction means the row survives exactly as long as
      // it is still needed, and a retry that arrives after a successful claim
      // finds nothing to delete and nothing to do, which is what idempotent means
      // here.
      //
      // Scoped to this environment's data keys, so an invitation covering four
      // environments is consumed four times, once per successful re-seal.
      if (params.claimInvitationId != null) {
        const claimed = await tx
          .select({ id: envKeyGrants.id })
          .from(envKeyGrants)
          .innerJoin(envDataKeys, eq(envDataKeys.id, envKeyGrants.envDataKeyId))
          .where(
            and(
              eq(envKeyGrants.invitationId, params.claimInvitationId),
              eq(envDataKeys.environmentId, params.environmentId),
            ),
          );

        if (claimed.length > 0) {
          await tx.delete(envKeyGrants).where(
            inArray(
              envKeyGrants.id,
              claimed.map((row) => row.id),
            ),
          );
        }
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
 * Three exclusions, and each is the answer to "must a rotation wait for this?".
 *
 * **Revoked** tokens are dead credentials.
 *
 * **Expired** tokens are dead in exactly the same way, and this is the same
 * predicate `findServiceTokenByHash` authenticates with — which is the point.
 * Without the two agreeing, a token that stopped working in March is still
 * *required* in every rotation afterwards: every attempt fails with "Missing a
 * grant for token:…", naming a credential that cannot authenticate and that
 * nobody thinks to revoke because it already stopped working. An environment's
 * keys become unrotatable until somebody revokes a token that is already dead.
 *
 * **Tokens with no public key** were minted before the Phase 4 creation flow, so
 * there is nothing to seal to and no client can invent one.
 *
 * ── What happens to a dead token's existing grants ──
 * Nothing deletes them, and a rotation simply omits the token. Its old grant
 * stays against the **retired** key, where it opens the history that token could
 * already read and nothing written since — which is exactly what a revocation
 * should leave behind. Deleting them here was the alternative and is worse: it
 * would silently rewrite what a credential could read, with no record of when.
 *
 * Until that rotation lands, the leftover grant makes `needsRotation` true, and
 * that is the honest reading: whoever held the token string may have fetched the
 * key while it still authenticated, so the environment is not actually safe from
 * it until the key is replaced. What has changed is only that the token is no
 * longer *required* — a rotation can now happen, where before it was refused
 * for ever with "Missing a grant for token:…".
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
        or(isNull(serviceTokens.expiresAt), sql`${serviceTokens.expiresAt} > now()`),
        isNotNull(serviceTokens.publicKey),
      ),
    );

  return rows.flatMap((row) => (row.publicKey ? [{ id: row.id, publicKey: row.publicKey }] : []));
}

/** An open invitation, with everything needed to decide what it may be sealed. */
export interface PendingInvitationForGrant {
  id: string;
  /** The role acceptance will assign, which sets the defaults. */
  role: OrgRole;
  /**
   * The access selection acceptance will apply, or `null` for "role defaults
   * everywhere" — the pre-selection shape. See `invitations.initial_grants`.
   */
  initialGrants: InvitationGrantSeed[] | null;
}

/**
 * One open invitation of this organisation, or `null`.
 *
 * Exists so a key grant can be checked against the invitation it names.
 * Tenant-scoped and state-scoped in one predicate: an invitation belonging to
 * another organisation, one already accepted, and one revoked all come back the
 * same way, because the caller is entitled to the same answer for all three —
 * "that invitation cannot hold a key here".
 *
 * The role and the selection come back with it because "may this invitation hold
 * *this environment's* key" is a different question from "does this invitation
 * exist", and only the caller — which has `can()` — can answer the first.
 */
export async function findPendingInvitationForGrant(
  exec: Executor,
  orgId: string,
  invitationId: string,
): Promise<PendingInvitationForGrant | null> {
  const [row] = await exec
    .select({
      id: invitations.id,
      role: invitations.role,
      initialGrants: invitations.initialGrants,
    })
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
 * Reads an invitation's sealed grants. Reads them; does not consume them.
 *
 * ── Why this stopped being a `take` ──
 * It used to read and delete in one transaction, on the argument that a fragment
 * sitting in a chat history never expires, so the window in which the row is
 * openable should be bounded to the acceptance itself. The argument is sound and
 * the implementation destroyed the feature: acceptance is the moment a person
 * *arrives*, and the primary population of an invitation link is somebody who has
 * no vault yet. They cannot re-seal anything until they have set one up — and by
 * the time they had, the grants had been deleted by the response that showed them.
 * The two-channel flow's entire value went to whoever happened to already be
 * signed in with an unlocked vault in the same tab.
 *
 * So consumption moved to the act that makes the row redundant: `addEnvKeyGrants`
 * deletes an invitation's grant for an environment in the same transaction that
 * stores the invitee's own re-sealed grant for it (see `claimInvitationId`). A
 * grant is destroyed once it has been *used*, per environment, and never before —
 * which also makes a partial failure resumable rather than final.
 *
 * ── The window that leaves, stated plainly ──
 * Between acceptance and the claim, the sealed grant remains in the database and
 * remains openable by anybody holding the fragment. That is a real residual risk
 * and it is recorded in ADR 0009 rather than argued away: it is bounded by the
 * invitee claiming (usually seconds later), by any rotation of the environment —
 * which retires the key the grant carries — and by the fact that the fragment was
 * always the weak half of a two-channel scheme. It buys a flow that works for the
 * people it was designed for.
 *
 * Only grants on **active** data keys are returned. One sealed against a
 * rotated-away key opens a key nothing is written under any more, and handing it
 * to a client that would faithfully re-seal it produces a grant that looks
 * exactly like a working one.
 */
export async function readInvitationGrants(
  exec: Executor,
  params: { orgId: string; invitationId: string },
): Promise<InvitationGrantRecord[]> {
  const rows = await exec
    .select({
      environmentId: envDataKeys.environmentId,
      projectSlug: projects.slug,
      environmentSlug: environments.slug,
      envDataKeyId: envDataKeys.id,
      edkVersion: envDataKeys.version,
      edkSealed: envKeyGrants.edkSealed,
      ehkSealed: envKeyGrants.ehkSealed,
    })
    .from(envKeyGrants)
    .innerJoin(envDataKeys, eq(envDataKeys.id, envKeyGrants.envDataKeyId))
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(envKeyGrants.invitationId, params.invitationId),
        // Tenant-scoped through `projects`, exactly as every other read here is.
        // Sealing a grant to a foreign invitation id needs nothing more than
        // knowing it, so without this join an invitation of one organisation
        // could serve another's blobs (threat T2).
        eq(projects.orgId, params.orgId),
        eq(envDataKeys.status, 'active'),
      ),
    );

  return rows;
}

/** An invitation whose sealed grants the accepting member has not claimed yet. */
export interface ClaimableInvitationRecord {
  invitationId: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  grants: InvitationGrantRecord[];
}

/**
 * Every invitation this account accepted that still has grants nobody has claimed.
 *
 * ── Why the key code has to be enterable after the fact ──
 * The two-channel flow assumes the second channel arrives second. It routinely
 * does not: the link is opened on a phone, the code is in an email on a laptop,
 * the person sets up their vault first and comes back. Every one of those was a
 * dead end while acceptance was the only moment the grants were served, and the
 * dead end was silent — the invitee saw an environment they could list and not
 * read, with nothing on screen connecting it to the code in their inbox.
 *
 * ── Why it is safe to serve these to a session ──
 * The blobs are sealed to the invitation's one-off X25519 public key. The session
 * asking cannot open them; only the fragment can, and the fragment has never been
 * near this server. What the session proves is *entitlement to try*: the rows are
 * scoped to invitations this user id accepted, so nobody learns of, or can claim,
 * anybody else's. That is the same standard `myGrant` is served under — ciphertext
 * addressed to a key the server does not hold.
 */
export async function listClaimableInvitationGrants(
  exec: Executor,
  userId: string,
): Promise<ClaimableInvitationRecord[]> {
  const rows = await exec
    .select({
      invitationId: invitations.id,
      orgId: organizations.id,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      environmentId: envDataKeys.environmentId,
      projectSlug: projects.slug,
      environmentSlug: environments.slug,
      envDataKeyId: envDataKeys.id,
      edkVersion: envDataKeys.version,
      edkSealed: envKeyGrants.edkSealed,
      ehkSealed: envKeyGrants.ehkSealed,
    })
    .from(envKeyGrants)
    .innerJoin(invitations, eq(invitations.id, envKeyGrants.invitationId))
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .innerJoin(envDataKeys, eq(envDataKeys.id, envKeyGrants.envDataKeyId))
    .innerJoin(environments, eq(environments.id, envDataKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(invitations.acceptedBy, userId),
        // The invitation's own organisation and the environment's must be the
        // same one. They always are for a grant written by the invite flow; the
        // predicate is here so that a row that named a foreign invitation could
        // never be served through it either.
        eq(projects.orgId, invitations.orgId),
        eq(envDataKeys.status, 'active'),
      ),
    );

  const byInvitation = new Map<string, ClaimableInvitationRecord>();
  for (const row of rows) {
    let record = byInvitation.get(row.invitationId);
    if (record === undefined) {
      record = {
        invitationId: row.invitationId,
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        orgName: row.orgName,
        grants: [],
      };
      byInvitation.set(row.invitationId, record);
    }
    record.grants.push({
      environmentId: row.environmentId,
      projectSlug: row.projectSlug,
      environmentSlug: row.environmentSlug,
      envDataKeyId: row.envDataKeyId,
      edkVersion: row.edkVersion,
      edkSealed: row.edkSealed,
      ehkSealed: row.ehkSealed,
    });
  }

  return [...byInvitation.values()];
}

/**
 * Whether this account may consume that invitation's grants, in this organisation.
 *
 * The one authorisation question the claim adds, and it is a narrow one: a grant
 * write may delete an invitation's rows **only** if the invitation belongs to the
 * organisation being written to and this user is the person who accepted it.
 * Without the second half, any member holding a key could name somebody else's
 * invitation and destroy the grants they had not claimed yet — a denial that
 * leaves no trace, because the pending-share fallback would quietly cover for it.
 */
export async function canClaimInvitationGrants(
  exec: Executor,
  params: { orgId: string; invitationId: string; userId: string },
): Promise<boolean> {
  const [row] = await exec
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.id, params.invitationId),
        eq(invitations.orgId, params.orgId),
        eq(invitations.acceptedBy, params.userId),
      ),
    )
    .limit(1);

  return row !== undefined;
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
    // Stored as the client stated it, because the signature covers it and the
    // row has to be verifiable from itself. See the column comment.
    recipientPublicKey: seed.recipientPublicKey,
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
  recipientPublicKey: Uint8Array;
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
/**
 * Refuses a write sealed against anything but this environment's live key.
 *
 * ── Why the message names both versions ──
 * The client's only correct response to this is to re-read `GET …/keys`, re-seal
 * against the key it gets back, and retry — and it can only decide that
 * automatically if the refusal distinguishes "you sealed against a key that has
 * been rotated away" from every other 409 this API can produce. Naming the
 * version the caller sealed for and the version that is now active makes the
 * conflict self-describing: `token-keys.ts` and `pending-shares.tsx` both branch
 * on it, and a human reading an audit trail can see how far behind the client was
 * rather than only that it was behind.
 *
 * Neither number is a secret: a caller holding a grant on this environment is
 * told the active version by the endpoint it just read.
 */
async function requireActiveKey(
  exec: Executor,
  environmentId: string,
  envDataKeyId: string,
): Promise<void> {
  const [row] = await exec
    .select({ id: envDataKeys.id, version: envDataKeys.version, status: envDataKeys.status })
    .from(envDataKeys)
    .where(and(eq(envDataKeys.id, envDataKeyId), eq(envDataKeys.environmentId, environmentId)))
    .limit(1);

  if (row?.status === 'active') return;

  const [active] = await exec
    .select({ version: envDataKeys.version })
    .from(envDataKeys)
    .where(and(eq(envDataKeys.environmentId, environmentId), eq(envDataKeys.status, 'active')))
    .limit(1);

  const sealedFor =
    row === undefined ? 'a key this environment has never had' : `version ${row.version}`;
  const nowActive = active === undefined ? 'no key at all' : `version ${active.version}`;

  throw new RepositoryError(
    'conflict',
    `These grants were sealed for ${sealedFor}; this environment's active key is ${nowActive}. Re-read its keys, seal against the active version, and retry.`,
  );
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
