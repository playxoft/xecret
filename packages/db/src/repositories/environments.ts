import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { DEFAULT_ALGORITHM } from '@xecret/core/crypto';
import type {
  Bytes,
  CipherAlgorithm,
  EnvelopeService,
  WrappedKey,
  WrappedOrgKey,
} from '@xecret/core/crypto';
import { envKeys, orgKeys } from '../schema/keys';
import { environments, projects } from '../schema/resources';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Environments and the key material that makes them usable.
 *
 * `environments` has no `org_id` column — it reaches the organisation through
 * `projects`. That indirection is the single most fragile tenancy control in the
 * schema: an environment id taken from a URL looks perfectly usable on its own,
 * and every query in this file that "obviously" only needs `environments.id` is
 * one refactor away from being a cross-tenant read (threat T2). Every lookup
 * here therefore either joins `projects` or applies `withinOrganization()`, and
 * the org predicate is written out rather than hidden behind a helper that
 * returns a whole query.
 */

export type EnvironmentRecord = typeof environments.$inferSelect;

export interface CreateEnvironmentParams {
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  isProduction?: boolean | undefined;
  sortOrder?: number | undefined;
  /**
   * Supplies the Env Data Key. Passed in rather than constructed here because
   * only the application layer knows how to resolve the Root KEK for the current
   * runtime, and a repository must not reach for ambient key material.
   */
  envelope: EnvelopeService;
}

export interface UpdateEnvironmentParams {
  name?: string | undefined;
  /**
   * Reclassifying an environment changes who may read it: production is
   * deny-by-default even for the `developer` role. Callers must audit this.
   */
  isProduction?: boolean | undefined;
  sortOrder?: number | undefined;
}

/**
 * An environment's unwrap chain, shaped for `EnvelopeService.openEnvKey`.
 *
 * Both levels come back from one query so the bulk read path never pays a second
 * round trip to walk from the environment key to the organisation key that
 * wrapped it.
 */
export interface EnvironmentKeyChain {
  /** Goes into `secret_versions.env_key_id` for anything encrypted under it. */
  envKeyId: string;
  envKey: WrappedKey;
  orgKey: WrappedOrgKey;
}

/**
 * Raised when a stored key or ciphertext row names a cipher this build does not
 * implement.
 *
 * `algorithm` is a `text` column so a future algorithm can be introduced without
 * a migration, which means the value read back is not automatically one of the
 * algorithms in `@xecret/core`. Asserting the type instead of checking it would
 * turn "a row from the future, or a tampered row" into a silent downgrade.
 */
export class UnsupportedAlgorithmError extends Error {
  constructor(readonly algorithm: string) {
    super(`Unsupported cipher algorithm: ${algorithm}`);
    this.name = 'UnsupportedAlgorithmError';
  }
}

/**
 * Creates an environment together with its Env Data Key, atomically.
 *
 * The two writes must not be separable. `secret_versions.env_key_id` is
 * `NOT NULL`, so an environment that exists without an active key silently
 * rejects every write it will ever receive, and the failure surfaces far away
 * from its cause. Nothing on the request path can repair it either: minting a
 * key requires unwrapping the organisation's master key, and this function is
 * the only place that does so at creation time. A half-created environment
 * therefore needs an operator with the Root KEK to fix — so it must not be
 * possible to create one.
 *
 * `exec.transaction()` opens a `SAVEPOINT` when `exec` is already a transaction,
 * so a caller that has its own boundary — "create the project and its three
 * environments, or none of them" — keeps it. Nothing here commits independently.
 */
export async function createEnvironment(
  exec: Executor,
  params: CreateEnvironmentParams,
): Promise<EnvironmentRecord> {
  return exec.transaction(async (tx) => {
    // Tenancy. `environments` cannot express "belongs to this organisation", so
    // resolving the parent project through `org_id` is the only thing preventing
    // a caller from creating an environment inside another tenant's project.
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, params.projectId),
          eq(projects.orgId, params.orgId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);

    if (!project) {
      throw new RepositoryError(
        'notFound',
        `Project ${params.projectId} not found in organisation ${params.orgId}`,
      );
    }

    // Kept as its own query rather than folded into the join above so that "no
    // such project" and "organisation has no active master key" stay
    // distinguishable. The second is an operator-level fault and deserves to say
    // so; creation is not a hot path, so the extra round trip costs nothing that
    // matters.
    const orgKey = await loadActiveOrgKey(tx, params.orgId);

    const [environment] = await tx
      .insert(environments)
      .values({
        id: uuidv7(),
        projectId: params.projectId,
        name: params.name,
        slug: params.slug,
        isProduction: params.isProduction ?? false,
        sortOrder: params.sortOrder ?? 0,
      })
      .onConflictDoNothing()
      .returning();

    if (!environment) {
      throw new RepositoryError(
        'conflict',
        `An environment with slug "${params.slug}" already exists in this project`,
      );
    }

    const wrapped = await params.envelope.createEnvKey({
      orgId: params.orgId,
      environmentId: environment.id,
      orgKey: orgKey.key,
    });

    await tx.insert(envKeys).values({
      id: uuidv7(),
      environmentId: environment.id,
      orgKeyId: orgKey.id,
      version: wrapped.version,
      wrappedKey: wrapped.ciphertext,
      wrapIv: wrapped.iv,
      algorithm: wrapped.algorithm,
    });

    return environment;
  });
}

/**
 * Lists a project's live environments in display order.
 *
 * Takes `orgId` even though `projectId` alone would return the same rows for a
 * legitimate caller: a bare project id from a URL proves nothing, and this is
 * precisely the IDOR shape threat T2 describes.
 */
/**
 * Every live environment in the organisation, with the project it belongs to.
 *
 * Exists for the effective-permission preview, which answers "what can this
 * member reach?" and therefore needs the whole grid in one query — per-project
 * calls to `listEnvironments` would be a query per project, on a page whose
 * point is to render all of them. Ordered by project then `sort_order` so the
 * grid renders in the same order the project pages do.
 */
export async function listEnvironmentsForOrganization(
  exec: Executor,
  orgId: string,
): Promise<OrganizationEnvironment[]> {
  return exec
    .select({
      ...environmentColumns,
      project: {
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
      },
    })
    .from(environments)
    .innerJoin(projects, and(eq(projects.id, environments.projectId), isNull(projects.deletedAt)))
    .where(and(eq(projects.orgId, orgId), isNull(environments.deletedAt)))
    .orderBy(asc(projects.createdAt), asc(projects.id), asc(environments.sortOrder));
}

export interface OrganizationEnvironment extends EnvironmentRecord {
  project: { id: string; name: string; slug: string };
}

export async function listEnvironments(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<EnvironmentRecord[]> {
  return exec
    .select(environmentColumns)
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(environments.projectId, projectId),
        eq(projects.orgId, orgId),
        isNull(projects.deletedAt),
        isNull(environments.deletedAt),
      ),
    )
    .orderBy(asc(environments.sortOrder), asc(environments.id));
}

/**
 * Resolves an environment by its project-scoped slug.
 *
 * **The join to `projects` is the tenancy control.** `environments` has no
 * `org_id`, so without it this function would happily return another tenant's
 * environment to anyone who guessed a project id. If a future change makes this
 * lookup "simpler" by dropping the join, it has removed the isolation boundary,
 * not a redundant condition.
 */
export async function findEnvironmentBySlug(
  exec: Executor,
  orgId: string,
  projectId: string,
  slug: string,
): Promise<EnvironmentRecord | undefined> {
  const [row] = await exec
    .select(environmentColumns)
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(environments.projectId, projectId),
        eq(environments.slug, slug),
        eq(projects.orgId, orgId),
        isNull(projects.deletedAt),
        isNull(environments.deletedAt),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Updates an environment's display fields and production flag.
 *
 * `slug` is immutable for the same reason as a project's: it is committed to
 * `.xecret.yaml` and CI configuration, so renaming it breaks every consumer that
 * is not redeployed simultaneously.
 */
export async function updateEnvironment(
  exec: Executor,
  orgId: string,
  environmentId: string,
  params: UpdateEnvironmentParams,
): Promise<EnvironmentRecord> {
  const patch: Partial<typeof environments.$inferInsert> = {};
  if (params.name !== undefined) patch.name = params.name;
  if (params.isProduction !== undefined) patch.isProduction = params.isProduction;
  if (params.sortOrder !== undefined) patch.sortOrder = params.sortOrder;

  const [row] = await exec
    .update(environments)
    // `now()` comes from the database, not the Worker — see the same note in
    // `updateProject`. Set inline because the column then holds a `SQL`
    // expression, which the insert-shaped `patch` cannot type.
    .set({ ...patch, updatedAt: sql`now()` })
    .where(
      and(
        eq(environments.id, environmentId),
        isNull(environments.deletedAt),
        withinOrganization(orgId),
      ),
    )
    .returning();

  if (!row) throw new RepositoryError('notFound', `Environment ${environmentId} not found`);

  return row;
}

/**
 * Marks an environment deleted.
 *
 * The `env_keys` row is left alone. Deleting it is cryptographic erasure — it
 * makes every secret in the environment permanently unreadable, including from
 * backups — and that is far too consequential to happen as a side effect of a
 * soft delete a user may want to undo.
 */
export async function softDeleteEnvironment(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<EnvironmentRecord> {
  const [row] = await exec
    .update(environments)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(environments.id, environmentId),
        isNull(environments.deletedAt),
        withinOrganization(orgId),
      ),
    )
    .returning();

  if (!row) throw new RepositoryError('notFound', `Environment ${environmentId} not found`);

  return row;
}

/**
 * Loads the active Env Data Key and the Org Master Key that wrapped it, in one
 * query, shaped so the result can go straight into `EnvelopeService.openEnvKey`.
 *
 * This is query one of the three that `xecret run` is allowed. Splitting it into
 * "fetch env key, then fetch its org key" would double the round trips on the
 * single hottest path in the product for no benefit.
 *
 * `org_keys` is joined by id and *also* constrained to `orgId`. That looks
 * redundant — the row is reached through `env_keys.org_key_id` — but it means a
 * mis-wired `org_key_id` produces no rows instead of handing back another
 * tenant's wrapped key for this Worker to try to unwrap.
 *
 * The org key is deliberately not filtered by `status`: during a root rotation
 * the key that wrapped this environment may already be retired, and the rows it
 * protects must stay readable until they are re-wrapped.
 */
export async function loadEnvironmentKeyChain(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<EnvironmentKeyChain | undefined> {
  const [row] = await exec
    .select({
      envKeyId: envKeys.id,
      envKeyVersion: envKeys.version,
      envWrappedKey: envKeys.wrappedKey,
      envWrapIv: envKeys.wrapIv,
      envAlgorithm: envKeys.algorithm,
      orgKeyVersion: orgKeys.version,
      orgWrappedKey: orgKeys.wrappedKey,
      orgWrapIv: orgKeys.wrapIv,
      orgAlgorithm: orgKeys.algorithm,
      rootKeyVersion: orgKeys.rootKeyVersion,
    })
    .from(envKeys)
    .innerJoin(environments, eq(environments.id, envKeys.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .innerJoin(orgKeys, eq(orgKeys.id, envKeys.orgKeyId))
    .where(
      and(
        eq(envKeys.environmentId, environmentId),
        eq(envKeys.status, 'active'),
        eq(projects.orgId, orgId),
        eq(orgKeys.orgId, orgId),
        isNull(projects.deletedAt),
        isNull(environments.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return undefined;

  return {
    envKeyId: row.envKeyId,
    envKey: {
      ciphertext: toBytes(row.envWrappedKey),
      iv: toBytes(row.envWrapIv),
      algorithm: toCipherAlgorithm(row.envAlgorithm),
      version: row.envKeyVersion,
    },
    orgKey: {
      ciphertext: toBytes(row.orgWrappedKey),
      iv: toBytes(row.orgWrapIv),
      algorithm: toCipherAlgorithm(row.orgAlgorithm),
      version: row.orgKeyVersion,
      rootKeyVersion: row.rootKeyVersion,
    },
  };
}

/**
 * The `org_id` predicate for statements whose target table is `environments`.
 *
 * `UPDATE` cannot join in the way a `SELECT` does, so the reach into `projects`
 * becomes a correlated `EXISTS`. Same control, different syntax: if a statement
 * in this file touches `environments` and neither joins `projects` nor calls
 * this, it is not tenant-scoped.
 */
export function withinOrganization(orgId: string): SQL {
  return sql`exists (
    select 1 from ${projects}
    where ${projects.id} = ${environments.projectId}
      and ${projects.orgId} = ${orgId}
      and ${projects.deletedAt} is null
  )`;
}

/**
 * Narrows a stored `algorithm` string to the allowlist in `@xecret/core`.
 *
 * Lives here rather than beside the secret repository because both the key rows
 * and the ciphertext rows carry this column and both must be checked the same
 * way; one implementation means one place to update when a second algorithm is
 * introduced.
 */
export function toCipherAlgorithm(value: string): CipherAlgorithm {
  if (value !== DEFAULT_ALGORITHM) throw new UnsupportedAlgorithmError(value);
  return value;
}

/**
 * Re-views a `bytea` column as the ArrayBuffer-backed array `@xecret/core` needs.
 *
 * Web Crypto rejects `SharedArrayBuffer`-backed views, so the crypto layer types
 * its byte arrays as `Uint8Array<ArrayBuffer>`. The driver already produces
 * exactly that at runtime, but its declared type is the wider `Uint8Array`, so
 * the narrowing has to happen somewhere. Copying rather than asserting keeps the
 * claim true no matter what the driver does later, and detaches the value from
 * the connection's read buffer. Secrets are small; the copy is not measurable.
 */
export function toBytes(value: Uint8Array): Bytes {
  return new Uint8Array(value);
}

/** Explicit column list so joined queries return a flat environment row. */
const environmentColumns = {
  id: environments.id,
  projectId: environments.projectId,
  name: environments.name,
  slug: environments.slug,
  isProduction: environments.isProduction,
  sortOrder: environments.sortOrder,
  createdAt: environments.createdAt,
  updatedAt: environments.updatedAt,
  deletedAt: environments.deletedAt,
};

/**
 * The organisation's current master key, as `EnvelopeService` expects it.
 *
 * Ordered by version rather than trusting that exactly one row is `active`: a
 * rotation that is interrupted between "insert the new key" and "retire the old
 * one" leaves two, and picking the newest is the behaviour that lets the system
 * keep working while an operator sorts it out.
 */
async function loadActiveOrgKey(
  exec: Executor,
  orgId: string,
): Promise<{ id: string; key: WrappedOrgKey }> {
  const [row] = await exec
    .select({
      id: orgKeys.id,
      version: orgKeys.version,
      wrappedKey: orgKeys.wrappedKey,
      wrapIv: orgKeys.wrapIv,
      algorithm: orgKeys.algorithm,
      rootKeyVersion: orgKeys.rootKeyVersion,
    })
    .from(orgKeys)
    .where(and(eq(orgKeys.orgId, orgId), eq(orgKeys.status, 'active')))
    .orderBy(desc(orgKeys.version))
    .limit(1);

  if (!row) {
    throw new RepositoryError(
      'notFound',
      `Organisation ${orgId} has no active master key; an operator must run key recovery before environments can be created`,
    );
  }

  return {
    id: row.id,
    key: {
      ciphertext: toBytes(row.wrappedKey),
      iv: toBytes(row.wrapIv),
      algorithm: toCipherAlgorithm(row.algorithm),
      version: row.version,
      rootKeyVersion: row.rootKeyVersion,
    },
  };
}
