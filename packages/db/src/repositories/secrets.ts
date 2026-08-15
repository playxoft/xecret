import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import type { EncryptedValue } from '@xecret/core/crypto';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { toBytes, toCipherAlgorithm } from './environments';
import { isUniqueViolation } from './users';
import { clampPageSize, RepositoryError } from './shared';
import type { Executor } from './shared';
import type { PageRequest } from './projects';

/**
 * Secrets and their versions.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **`secret_versions` is append-only.** An update inserts a new row. Nothing
 *    here issues an `UPDATE` against it, and nothing should: rotation, rollback,
 *    and "what was this value on Tuesday" all fall out of the history for free,
 *    and they all stop working the moment one row is mutated in place.
 *
 * 2. **Exactly three functions return ciphertext** — `loadEnvironmentSecrets`,
 *    `findSecretByName`, and `getSecretVersion`. That is a deliberately small,
 *    greppable set: `grep -rn 'getSecretVersion\|loadEnvironmentSecrets' ` is the
 *    complete list of places a decryption can begin. The listing functions use
 *    explicit column lists so ciphertext is never fetched and then discarded;
 *    fetching it "just in case" puts plaintext-adjacent bytes into a response
 *    buffer that had no reason to hold them.
 *
 * 3. **Every ciphertext comes back with the context needed to build its AAD** —
 *    `secret_id`, `version`, `env_key_id`, `iv`, and `algorithm`. The AAD binds
 *    `org_id ‖ environment_id ‖ secret_id ‖ version`, which is what stops a
 *    ciphertext row being relocated into an environment the caller may read.
 *    Handing back ciphertext without that context is how a relocation bug gets
 *    introduced: the caller has to guess, and one day it guesses wrong.
 */

export type SecretRecord = typeof secrets.$inferSelect;

export interface SecretListItem {
  id: string;
  environmentId: string;
  name: string;
  note: string | null;
  /** One of `SECRET_VALUE_TYPES`. Left as the raw column — see `SecretMaterial`. */
  valueType: string;
  /** Exactly one of these two is set — `secrets_writer_check`. */
  createdBy: string | null;
  createdByServiceTokenId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Highest version number. Resolved in the same statement, not per row. */
  latestVersion: number;
}

export interface SecretPage {
  items: SecretListItem[];
  hasMore: boolean;
}

export interface SecretVersionSummary {
  id: string;
  secretId: string;
  version: number;
  envKeyId: string;
  /**
   * Left as the raw column value rather than narrowed to `CipherAlgorithm`.
   * History is the one view that must still render when a row names something
   * this build cannot decrypt — that is exactly when an operator needs to see it.
   */
  algorithm: string;
  /** Exactly one of these two is set — `secret_versions_writer_check`. */
  createdBy: string | null;
  createdByServiceTokenId: string | null;
  createdAt: Date;
}

export interface SecretVersionPage {
  items: SecretVersionSummary[];
  hasMore: boolean;
}

/**
 * A secret version with its ciphertext and everything needed to decrypt it.
 *
 * `environmentId` is carried even when the caller supplied it, so that building
 * an `EncryptionContext` never requires stitching together values from two
 * different places.
 */
export interface SecretMaterial {
  secretId: string;
  name: string;
  /**
   * The declared shape of the value, as stored.
   *
   * A plain `string` rather than the `SecretValueType` union, for the same
   * reason `algorithm` above is: a row written by a newer deployment may name a
   * type this build has never heard of, and a read path that refuses to
   * represent it cannot show the user their own secret. Narrowing is the
   * caller's job, through `toSecretValueType`, which falls back to `string`.
   */
  valueType: string;
  environmentId: string;
  versionId: string;
  version: number;
  envKeyId: string;
  encrypted: EncryptedValue;
  valueHmac: Uint8Array | null;
  createdBy: string | null;
  createdByServiceTokenId: string | null;
  createdAt: Date;
}

/**
 * Who a write is attributed to: a person, or a named service token — never
 * both, never neither. The CHECK constraints are the arbiter; this type makes
 * the two shapes explicit at the call site, and `writerColumns` refuses at
 * runtime what a cast might sneak past the compiler.
 */
export type SecretWriterRef =
  { userId: string; serviceTokenId?: undefined } | { serviceTokenId: string; userId?: undefined };

/** The column pair a writer reference stores as. */
export function writerColumns(writer: SecretWriterRef): {
  createdBy: string | null;
  createdByServiceTokenId: string | null;
} {
  const userId = writer.userId ?? null;
  const serviceTokenId = writer.serviceTokenId ?? null;

  if ((userId === null) === (serviceTokenId === null)) {
    throw new RepositoryError('invalid', 'A write must name exactly one writer.');
  }

  return { createdBy: userId, createdByServiceTokenId: serviceTokenId };
}

export interface CreateSecretParams {
  orgId: string;
  environmentId: string;
  name: string;
  note?: string | null | undefined;
  /** Defaults to `string`, which accepts anything, when omitted. */
  valueType?: string | undefined;
  /**
   * The id to assign, supplied by the caller.
   *
   * A secret's ciphertext is bound by AAD to `secret_id`, so the id has to
   * exist *before* the value can be encrypted — a row minted here and handed
   * back afterwards would be one the caller could not have encrypted for, and
   * the resulting ciphertext would never decrypt again. Optional so callers
   * that store no ciphertext of their own (fixtures, tests) need not care.
   */
  id?: string | undefined;
  /** The `env_keys` row the value was encrypted under. */
  envKeyId: string;
  /** Exactly what `EnvelopeService.encrypt` returned. */
  encrypted: EncryptedValue;
  valueHmac?: Uint8Array | null | undefined;
  writer: SecretWriterRef;
}

export interface AddSecretVersionParams {
  orgId: string;
  secretId: string;
  envKeyId: string;
  encrypted: EncryptedValue;
  valueHmac?: Uint8Array | null | undefined;
  writer: SecretWriterRef;
}

/**
 * Lists an environment's secrets: names and metadata, never values.
 *
 * The dashboard's default view must not pull encrypted payloads it has no
 * intention of decrypting, so the select list is written out explicitly. Loading
 * the row and dropping `ciphertext` afterwards would look identical from the
 * outside and be wrong in every way that matters — the bytes still cross the
 * network, still land in a buffer, and still show up in a query log.
 *
 * `latestVersion` is a correlated subquery served by `secret_versions_current_idx`,
 * not a second round trip per secret.
 */
export async function listSecrets(
  exec: Executor,
  orgId: string,
  environmentId: string,
  page: PageRequest = {},
): Promise<SecretPage> {
  const pageSize = clampPageSize(page.pageSize);
  const offset = Math.max((page.page ?? 1) - 1, 0) * pageSize;

  const rows = await exec
    .select({
      id: secrets.id,
      environmentId: secrets.environmentId,
      name: secrets.name,
      note: secrets.note,
      valueType: secrets.valueType,
      createdBy: secrets.createdBy,
      createdByServiceTokenId: secrets.createdByServiceTokenId,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
      latestVersion: sql<number>`(
        select coalesce(max(${secretVersions.version}), 0)
        from ${secretVersions}
        where ${secretVersions.secretId} = ${secrets.id}
      )`,
    })
    .from(secrets)
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secrets.environmentId, environmentId),
        eq(projects.orgId, orgId),
        isNull(secrets.deletedAt),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(secrets.name))
    .limit(pageSize + 1)
    .offset(offset);

  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/**
 * Loads the current version of every secret in an environment. **One query.**
 *
 * This is the bulk read path behind `xecret run` and `xecret pull`, and it is the
 * single most important performance property in the product: combined with
 * `loadEnvironmentKeyChain` and one audit insert it holds the whole request to
 * the three-query budget a Worker's connection allowance permits, regardless of
 * whether the environment holds five secrets or five thousand.
 *
 * `DISTINCT ON (secret_id) … ORDER BY secret_id, version DESC` rather than
 * `row_number() OVER (PARTITION BY secret_id ORDER BY version DESC)`: the
 * ordering is exactly `secret_versions_current_idx (secret_id, version DESC)`, so
 * PostgreSQL walks the index and emits the first row of each group. The window
 * function has to compute a rank over *every* version row and then throw away
 * all but one — it reads the entire history to answer a question about the head
 * of it. Both are one statement; only one of them is O(live secrets).
 *
 * Deliberately unpaginated. Truncating this result would hand a deploy a partial
 * environment, and a process that starts with three of its four secrets fails in
 * a far more confusing way than one that does not start at all. The bound on
 * environment size belongs at write time, not here.
 */
export async function loadEnvironmentSecrets(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<SecretMaterial[]> {
  const rows = await exec
    .selectDistinctOn([secretVersions.secretId], {
      secretId: secrets.id,
      name: secrets.name,
      valueType: secrets.valueType,
      environmentId: secrets.environmentId,
      versionId: secretVersions.id,
      version: secretVersions.version,
      envKeyId: secretVersions.envKeyId,
      ciphertext: secretVersions.ciphertext,
      iv: secretVersions.iv,
      algorithm: secretVersions.algorithm,
      valueHmac: secretVersions.valueHmac,
      createdBy: secretVersions.createdBy,
      createdByServiceTokenId: secretVersions.createdByServiceTokenId,
      createdAt: secretVersions.createdAt,
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secrets.environmentId, environmentId),
        eq(projects.orgId, orgId),
        isNull(secrets.deletedAt),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(secretVersions.secretId), desc(secretVersions.version));

  return rows.map(toSecretMaterial);
}

/**
 * Resolves one secret by name, with its current value.
 *
 * Returns ciphertext: this is `xecret get NAME`, and splitting it into a
 * metadata lookup followed by a version fetch would double the queries on a path
 * whose entire job is to produce one value.
 */
export async function findSecretByName(
  exec: Executor,
  orgId: string,
  environmentId: string,
  name: string,
): Promise<SecretMaterial | undefined> {
  const [row] = await exec
    .selectDistinctOn([secretVersions.secretId], {
      secretId: secrets.id,
      name: secrets.name,
      valueType: secrets.valueType,
      environmentId: secrets.environmentId,
      versionId: secretVersions.id,
      version: secretVersions.version,
      envKeyId: secretVersions.envKeyId,
      ciphertext: secretVersions.ciphertext,
      iv: secretVersions.iv,
      algorithm: secretVersions.algorithm,
      valueHmac: secretVersions.valueHmac,
      createdBy: secretVersions.createdBy,
      createdByServiceTokenId: secretVersions.createdByServiceTokenId,
      createdAt: secretVersions.createdAt,
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secrets.environmentId, environmentId),
        eq(secrets.name, name),
        eq(projects.orgId, orgId),
        isNull(secrets.deletedAt),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(secretVersions.secretId), desc(secretVersions.version));

  return row ? toSecretMaterial(row) : undefined;
}

/**
 * Creates a secret and its first version.
 *
 * A duplicate name surfaces as `conflict`, decided by `secrets_env_name_idx`
 * rather than by a `SELECT` beforehand. A check-then-insert is not a weaker
 * guarantee, it is no guarantee at all: two requests can both read "free" and
 * both proceed, and the only thing that has ever prevented that is the index.
 * `ON CONFLICT DO NOTHING` lets it decide and reports the decision as an empty
 * `RETURNING`.
 *
 * The index is partial (`WHERE deleted_at IS NULL`), so a soft-deleted secret
 * releases its name and creating a fresh secret with the same name succeeds —
 * which is what a user who deleted `DATABASE_URL` by mistake expects.
 */
export async function createSecret(
  exec: Executor,
  params: CreateSecretParams,
): Promise<{ secret: SecretRecord; version: SecretVersionSummary }> {
  return exec.transaction(async (tx) => {
    // Tenancy. Neither `secrets` nor `secret_versions` carries `org_id`, so the
    // environment has to be resolved through its project before anything is
    // written into it.
    const [environment] = await tx
      .select({ id: environments.id })
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
      .limit(1);

    if (!environment) {
      throw new RepositoryError(
        'notFound',
        `Environment ${params.environmentId} not found in organisation ${params.orgId}`,
      );
    }

    const [secret] = await tx
      .insert(secrets)
      .values({
        id: params.id ?? uuidv7(),
        environmentId: params.environmentId,
        name: params.name,
        note: params.note ?? null,
        valueType: params.valueType ?? 'string',
        ...writerColumns(params.writer),
      })
      .onConflictDoNothing()
      .returning();

    if (!secret) {
      throw new RepositoryError(
        'conflict',
        `A secret named "${params.name}" already exists in this environment`,
      );
    }

    const [version] = await tx
      .insert(secretVersions)
      .values({
        id: uuidv7(),
        secretId: secret.id,
        version: 1,
        ciphertext: params.encrypted.ciphertext,
        iv: params.encrypted.iv,
        envKeyId: params.envKeyId,
        algorithm: params.encrypted.algorithm,
        valueHmac: params.valueHmac ?? null,
        ...writerColumns(params.writer),
      })
      .returning(versionSummaryColumns);

    if (!version) {
      // Unreachable: an INSERT … RETURNING that inserted a row returns it. Left
      // as a throw rather than a non-null assertion so a future change that adds
      // an ON CONFLICT clause here fails loudly instead of returning a lie.
      throw new RepositoryError('conflict', `Failed to create the first version of ${secret.id}`);
    }

    return { secret, version };
  });
}

/**
 * Appends a new version to an existing secret.
 *
 * The version number is `MAX(version) + 1` computed *inside the INSERT*, not
 * read into the application and sent back. Under `READ COMMITTED` that still
 * does not serialise anything: two concurrent writers can both evaluate the
 * subquery against the same snapshot and both compute `4`. It is not meant to.
 * What it buys is that the window is a single statement rather than a network
 * round trip, and the actual guarantee is
 * `secret_versions_secret_version_unique` — one writer commits, the other gets
 * SQLSTATE 23505, which is translated here into `conflict` so the caller can
 * simply retry. A retry is correct because nothing was written: the loser's
 * whole transaction rolls back.
 *
 * This is also why there is no `UPDATE` in this function. Mutating the current
 * row would make two concurrent writes silently last-write-wins, which for a
 * secret means one of the two values vanishes with no record that it existed.
 */
export async function addSecretVersion(
  exec: Executor,
  params: AddSecretVersionParams,
): Promise<SecretVersionSummary> {
  return exec.transaction(async (tx) => {
    const [secret] = await tx
      .select({ id: secrets.id })
      .from(secrets)
      .innerJoin(environments, eq(environments.id, secrets.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(secrets.id, params.secretId),
          eq(projects.orgId, params.orgId),
          isNull(secrets.deletedAt),
          isNull(environments.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);

    if (!secret) {
      throw new RepositoryError(
        'notFound',
        `Secret ${params.secretId} not found in organisation ${params.orgId}`,
      );
    }

    try {
      const [version] = await tx
        .insert(secretVersions)
        .values({
          id: uuidv7(),
          secretId: params.secretId,
          version: sql<number>`(
            select coalesce(max(${secretVersions.version}), 0) + 1
            from ${secretVersions}
            where ${secretVersions.secretId} = ${params.secretId}
          )`,
          ciphertext: params.encrypted.ciphertext,
          iv: params.encrypted.iv,
          envKeyId: params.envKeyId,
          algorithm: params.encrypted.algorithm,
          valueHmac: params.valueHmac ?? null,
          ...writerColumns(params.writer),
        })
        .returning(versionSummaryColumns);

      if (!version) {
        throw new RepositoryError('conflict', `Failed to append a version to ${params.secretId}`);
      }

      // Keeps `secrets.updated_at` meaningful: the versions table is append-only,
      // so the parent row is the only place "when did this secret last change"
      // can be read without an aggregate.
      await tx
        .update(secrets)
        .set({ updatedAt: sql`now()` })
        .where(and(eq(secrets.id, params.secretId), withinOrganization(params.orgId)));

      return version;
    } catch (error) {
      if (isUniqueViolation(error, 'secret_versions_secret_version_unique')) {
        throw new RepositoryError(
          'conflict',
          `Another writer claimed the next version of secret ${params.secretId}; retry`,
        );
      }
      throw error;
    }
  });
}

/**
 * A secret's version history for the UI. Metadata only — no ciphertext, no IV,
 * no HMAC. Rendering a history page must not be a decryption opportunity.
 *
 * Deliberately does not require the secret to be live: the history of a deleted
 * secret is exactly what someone investigating a deletion needs to see.
 */
export async function listSecretVersions(
  exec: Executor,
  orgId: string,
  secretId: string,
  page: PageRequest = {},
): Promise<SecretVersionPage> {
  const pageSize = clampPageSize(page.pageSize);
  const offset = Math.max((page.page ?? 1) - 1, 0) * pageSize;

  const rows = await exec
    .select(versionSummaryColumns)
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secretVersions.secretId, secretId),
        eq(projects.orgId, orgId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(desc(secretVersions.version))
    .limit(pageSize + 1)
    .offset(offset);

  return { items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/**
 * Fetches one specific version, ciphertext included.
 *
 * This is the "I am about to decrypt" call — dashboard reveal, rollback,
 * re-encryption during key rotation. It is a separate function from the listings
 * precisely so that it is trivial to find every caller in review, and so that
 * nobody reaches for a listing function and then quietly needs one more field.
 *
 * Soft-deleted secrets are still readable by version, deliberately: rolling back
 * or exporting a deleted secret is a legitimate recovery operation, and the
 * authorization layer — not the repository — decides who may perform it.
 */
export async function getSecretVersion(
  exec: Executor,
  orgId: string,
  secretId: string,
  version: number,
): Promise<SecretMaterial | undefined> {
  const [row] = await exec
    .select({
      secretId: secrets.id,
      name: secrets.name,
      valueType: secrets.valueType,
      environmentId: secrets.environmentId,
      versionId: secretVersions.id,
      version: secretVersions.version,
      envKeyId: secretVersions.envKeyId,
      ciphertext: secretVersions.ciphertext,
      iv: secretVersions.iv,
      algorithm: secretVersions.algorithm,
      valueHmac: secretVersions.valueHmac,
      createdBy: secretVersions.createdBy,
      createdByServiceTokenId: secretVersions.createdByServiceTokenId,
      createdAt: secretVersions.createdAt,
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secretVersions.secretId, secretId),
        eq(secretVersions.version, version),
        eq(projects.orgId, orgId),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);

  return row ? toSecretMaterial(row) : undefined;
}

/**
 * Marks a secret deleted. Its versions are left untouched — they are the record
 * of what the value used to be, and `restoreSecret` depends on them surviving.
 */
export async function softDeleteSecret(
  exec: Executor,
  orgId: string,
  secretId: string,
): Promise<SecretRecord> {
  const [row] = await exec
    .update(secrets)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(secrets.id, secretId), isNull(secrets.deletedAt), withinOrganization(orgId)))
    .returning();

  if (!row) throw new RepositoryError('notFound', `Secret ${secretId} not found`);

  return row;
}

/**
 * Restores a soft-deleted secret.
 *
 * Fails with `conflict` if a new secret has taken the name, for the same reason
 * `restoreProject` does: the partial unique index released the name on deletion,
 * and the index — not a pre-flight `SELECT` — is what notices it was reused.
 */
export async function restoreSecret(
  exec: Executor,
  orgId: string,
  secretId: string,
): Promise<SecretRecord> {
  try {
    const [row] = await exec
      .update(secrets)
      .set({ deletedAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(secrets.id, secretId),
          sql`${secrets.deletedAt} is not null`,
          withinOrganization(orgId),
        ),
      )
      .returning();

    if (!row) throw new RepositoryError('notFound', `No deleted secret ${secretId} to restore`);

    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'secrets_env_name_idx')) {
      throw new RepositoryError(
        'conflict',
        `The name of secret ${secretId} is in use by another secret in this environment`,
      );
    }
    throw error;
  }
}

export interface UpdateSecretMetadataParams {
  orgId: string;
  environmentId: string;
  name: string;
  /**
   * Omit to leave unchanged. Renames the secret: the versions hang off the
   * secret's id, so the history survives, but everything that reads the secret
   * *by name* — `xecret run`, service tokens, other people's shells — sees the
   * old name vanish. The caller is expected to have said so to the user.
   */
  newName?: string | undefined;
  /** Omit to leave unchanged. */
  note?: string | null | undefined;
  /** Omit to leave unchanged. One of `SECRET_VALUE_TYPES`. */
  valueType?: string | undefined;
}

/**
 * Changes what is said *about* a secret, without touching what it holds.
 *
 * Declaring `PORT` an integer is not a rotation. It appends no version, writes
 * no ciphertext, and needs no key — so it must not go through the write path,
 * which would bump the version number and make "when did this credential last
 * actually change?" unanswerable for the sake of a label.
 *
 * The consequence worth stating: a type can be declared that the *current* value
 * does not satisfy. That is deliberate. The alternative is decrypting a secret
 * because somebody used a dropdown, and refusing the change until the value is
 * fixed makes the common repair — declare the type, then correct the value —
 * impossible to perform in either order. The API validates the value against the
 * type on the next write, which is the moment the plaintext is legitimately in
 * hand anyway.
 *
 * A rename travels this path too, for the same reason: the name is a label on
 * the secret's id, and the versions — which reference the id, never the name —
 * stay attached through it. What a rename *does* break is every reader that
 * addresses the secret by name, which is why the API records the old name in
 * the audit event.
 */
export async function updateSecretMetadata(
  exec: Executor,
  params: UpdateSecretMetadataParams,
): Promise<SecretRecord> {
  const patch: Record<string, unknown> = {};
  if (params.newName !== undefined) patch['name'] = params.newName;
  if (params.note !== undefined) patch['note'] = params.note;
  if (params.valueType !== undefined) patch['valueType'] = params.valueType;

  if (Object.keys(patch).length === 0) {
    throw new RepositoryError('invalid', 'No secret metadata was supplied to update.');
  }

  try {
    const [row] = await exec
      .update(secrets)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(
        and(
          eq(secrets.name, params.name),
          eq(secrets.environmentId, params.environmentId),
          isNull(secrets.deletedAt),
          withinOrganization(params.orgId),
        ),
      )
      .returning();

    if (!row) {
      throw new RepositoryError('notFound', `No secret named "${params.name}" in this environment`);
    }

    return row;
  } catch (error) {
    // A rename racing another live secret with the target name. The index —
    // not a pre-flight `SELECT` — is what notices, same as `restoreSecret`.
    if (isUniqueViolation(error, 'secrets_env_name_idx')) {
      throw new RepositoryError(
        'conflict',
        `The name "${params.newName ?? params.name}" is in use by another secret in this environment`,
      );
    }
    throw error;
  }
}

/** Counts an environment's live secrets, for quota checks and list headers. */
export async function countSecrets(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<number> {
  const [row] = await exec
    .select({ total: count() })
    .from(secrets)
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(secrets.environmentId, environmentId),
        eq(projects.orgId, orgId),
        isNull(secrets.deletedAt),
        isNull(environments.deletedAt),
        isNull(projects.deletedAt),
      ),
    );

  return row?.total ?? 0;
}

/**
 * The `org_id` predicate for statements whose target table is `secrets`.
 *
 * `UPDATE` cannot join the way a `SELECT` does, so the two hops out to the
 * organisation become a correlated `EXISTS`. Any statement in this file that
 * writes to `secrets` and does not carry this is a cross-tenant write.
 */
function withinOrganization(orgId: string): SQL {
  return sql`exists (
    select 1 from ${environments}
    inner join ${projects} on ${projects.id} = ${environments.projectId}
    where ${environments.id} = ${secrets.environmentId}
      and ${projects.orgId} = ${orgId}
      and ${environments.deletedAt} is null
      and ${projects.deletedAt} is null
  )`;
}

/** The version columns that are safe to expose in a listing. No ciphertext. */
const versionSummaryColumns = {
  id: secretVersions.id,
  secretId: secretVersions.secretId,
  version: secretVersions.version,
  envKeyId: secretVersions.envKeyId,
  algorithm: secretVersions.algorithm,
  createdBy: secretVersions.createdBy,
  createdByServiceTokenId: secretVersions.createdByServiceTokenId,
  createdAt: secretVersions.createdAt,
};

interface CiphertextRow {
  secretId: string;
  name: string;
  valueType: string;
  environmentId: string;
  versionId: string;
  version: number;
  envKeyId: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  algorithm: string;
  valueHmac: Uint8Array | null;
  createdBy: string | null;
  createdByServiceTokenId: string | null;
  createdAt: Date;
}

/**
 * Assembles the decryption-ready shape from a row.
 *
 * The algorithm is validated rather than asserted here — unlike in a version
 * listing — because this value is about to select a cipher. A row naming
 * something this build does not implement must fail closed.
 */
function toSecretMaterial(row: CiphertextRow): SecretMaterial {
  return {
    secretId: row.secretId,
    name: row.name,
    valueType: row.valueType,
    environmentId: row.environmentId,
    versionId: row.versionId,
    version: row.version,
    envKeyId: row.envKeyId,
    encrypted: {
      ciphertext: toBytes(row.ciphertext),
      iv: toBytes(row.iv),
      algorithm: toCipherAlgorithm(row.algorithm),
    },
    valueHmac: row.valueHmac,
    createdBy: row.createdBy,
    createdByServiceTokenId: row.createdByServiceTokenId,
    createdAt: row.createdAt,
  };
}
