import { and, asc, count, eq, gt, inArray, not, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import type { Entitlements } from '@xecret/core/entitlements';
import { orgSubscriptions } from '../schema/billing';
import { envDataKeys, envHmacKeys } from '../schema/env-keys';
import { envKeys, orgKeys } from '../schema/keys';
import { environments, projects } from '../schema/resources';
import { retainedVaultGrants, retainedVaults } from '../schema/retained-vaults';
import { secrets } from '../schema/secrets';
import { organizations } from '../schema/tenancy';
import { entitlementColumns, entitlementsFromRow } from './subscriptions';
import type { Executor } from './shared';

/**
 * The deleted-data purge: what turns a soft delete into an erasure.
 *
 * Deleting an organisation, a project, an environment or a secret only sets
 * `deleted_at`. Every read filters on it, so the thing is gone for everybody at
 * once — but the rows, the ciphertext and the wrapped keys are still here.
 * Thirty days later this file removes them for good.
 *
 * ── Why thirty days, and not at once ──
 * What these rows hold is credentials, and a credential is deleted far more
 * often by accident than on purpose: the wrong environment selected, a script
 * that cleaned up too much, a teammate who did not know a value was still in
 * use — or a compromised account removing things on its way out. The first sign
 * is usually an outage days later, when the application holding the value
 * restarts and cannot fetch it. Thirty days gives an owner time to notice and
 * ask for it back, and gives an incident review the rows it needs to establish
 * what existed and what happened to it.
 *
 * ── Why thirty days, and not longer ──
 * Past that window a deleted credential does nothing but carry risk: one more
 * copy of a secret in the database, readable by anybody who obtains it. So the
 * rows are removed — values, every earlier version, and the keys they were
 * encrypted under — and none of it can be brought back afterwards.
 *
 * ── One exception, for point-in-time restore ──
 * A secret deleted from an environment that still exists is kept for the longer
 * of thirty days and its organisation's point-in-time restore window
 * (`pitrDays`: 180 days on Team, a year on Enterprise). Restoring an
 * environment to an earlier moment brings back the secrets deleted since
 * (`server/restore-point.ts`), and it can only do that if they are still here.
 * Purging them on the thirty-day clock would quietly break a feature a customer
 * pays for. A whole environment, project or organisation cannot be restored to
 * a moment, so those go at thirty days.
 *
 * ── The order, and why it has to be this one ──
 * Key rows are `ON DELETE RESTRICT` on purpose (`schema/keys.ts`): a key must
 * never vanish as the side effect of deleting something else. So the purge
 * deletes them itself, explicitly, after the ciphertext that needs them:
 *
 *   secrets (their versions cascade) → env_keys, env_data_keys, env_hmac_keys
 *     → environments / projects → org_keys → organizations
 *
 * Everything else — members, invitations, tokens, grants, billing rows, roles,
 * webhooks — cascades from the row deleted last. The audit log has no foreign
 * keys (`schema/audit.ts`) and is append-only by grant, so every record ever
 * filed against what was purged stays exactly as it was.
 *
 * ── What waits ──
 * Two things hold a purge back for a later run rather than failing it:
 *  - a reset vault, inside its seven days, that holds a grant on one of the
 *    environment keys: migration 0020 refuses to let that grant go early, and
 *    the vault is allowed to finish its window first;
 *  - an organisation whose subscription the payment provider still bills,
 *    which waits for the cancellation to reach the end of its paid period
 *    (`listEndedCancellations`) so that nothing is left renewing for an
 *    organisation that no longer exists.
 *
 * Every cutoff is computed by the database's clock (`now()`), never the
 * Worker's, and every delete re-states it, under a row lock taken with
 * `SKIP LOCKED` so that two purges running at once divide the work rather than
 * queue behind each other.
 */

/**
 * How long deleted organisations, projects, environments and secrets are kept
 * before they are erased. The privacy policy publishes this number, and no
 * purge here will run on anything shorter.
 */
export const DELETED_DATA_RETENTION_DAYS = 30;

/** How long a secret deleted from a live environment is kept, for these entitlements. */
export function deletedSecretRetentionDays(entitlements: Entitlements): number {
  return Math.max(DELETED_DATA_RETENTION_DAYS, entitlements.limits.pitrDays);
}

function assertRetention(days: number): void {
  if (!Number.isInteger(days) || days < DELETED_DATA_RETENTION_DAYS) {
    throw new RangeError(
      `A purge keeps deleted data for at least ${DELETED_DATA_RETENTION_DAYS} days; got ${days}.`,
    );
  }
}

/** `column` was set at least `days` days ago, by the database's clock. */
function deletedAtLeast(column: AnyColumn, days: number): SQL {
  return sql`${column} <= now() - make_interval(days => ${days}::int)`;
}

/** Every environment of the organisation `orgId` names, deleted or not. */
function environmentsOfOrganization(orgId: SQL | AnyColumn): SQL {
  return sql`select ${environments.id} from ${environments}
    inner join ${projects} on ${projects.id} = ${environments.projectId}
    where ${projects.orgId} = ${orgId}`;
}

/** Every environment of the project `projectId` names, deleted or not. */
function environmentsOfProject(projectId: SQL | AnyColumn): SQL {
  return sql`select ${environments.id} from ${environments}
    where ${environments.projectId} = ${projectId}`;
}

/**
 * A reset vault still inside its seven days holds a grant on a key of one of
 * these environments. Deleting the key would cascade to that grant, which
 * migration 0020's trigger refuses — by the same test, written the same way.
 */
function heldByRetainedVault(environmentIds: SQL): SQL {
  return sql`exists (
    select 1 from ${retainedVaultGrants}
    inner join ${retainedVaults} on ${retainedVaults.id} = ${retainedVaultGrants.retainedVaultId}
    inner join ${envDataKeys} on ${envDataKeys.id} = ${retainedVaultGrants.envDataKeyId}
    where ${envDataKeys.environmentId} in (${environmentIds})
      and ${retainedVaults.purgeAfter} > now()
  )`;
}

/**
 * The organisation's subscription is one the payment provider still bills — a
 * paid row following a provider subscription (`billedByASnapshot` in
 * `billing.ts`). A cancelled one turns Free at the end of its period, and the
 * purge waits for that.
 */
function stillBilled(orgId: AnyColumn): SQL {
  return sql`exists (
    select 1 from ${orgSubscriptions}
    where ${orgSubscriptions.orgId} = ${orgId}
      and ${orgSubscriptions.plan} <> 'free'
      and ${orgSubscriptions.dodoSubscriptionId} is not null
      and ${orgSubscriptions.dodoProductId} is not null
  )`;
}

/** No other environment names this one as its parent (migration 0028's foreign key). */
function hasNoChildEnvironment(): SQL {
  return sql`not exists (
    select 1 from ${environments} as "child"
    where "child"."parent_environment_id" = ${environments.id}
  )`;
}

/**
 * Deletes the ciphertext and the keys of every environment `environmentIds`
 * names: the secrets first, since their versions are what the keys are
 * `RESTRICT`ed by, then each kind of key. Leaves the environment rows for the
 * caller, whose delete then has nothing left to be refused by.
 */
async function eraseEnvironmentContents(tx: Executor, environmentIds: SQL): Promise<void> {
  await tx.delete(secrets).where(sql`${secrets.environmentId} in (${environmentIds})`);
  await tx.delete(envKeys).where(sql`${envKeys.environmentId} in (${environmentIds})`);
  await tx.delete(envDataKeys).where(sql`${envDataKeys.environmentId} in (${environmentIds})`);
  await tx.delete(envHmacKeys).where(sql`${envHmacKeys.environmentId} in (${environmentIds})`);
}

async function countEnvironments(tx: Executor, environmentIds: SQL): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(environments)
    .where(sql`${environments.id} in (${environmentIds})`);
  return row?.total ?? 0;
}

async function countSecrets(tx: Executor, environmentIds: SQL): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(secrets)
    .where(sql`${secrets.environmentId} in (${environmentIds})`);
  return row?.total ?? 0;
}

// ── Organisations ───────────────────────────────────────────────────────────

/** An organisation whose thirty days are over and that nothing holds back. */
export interface OrganizationDueForPurge {
  id: string;
  slug: string;
  /** The WorkOS organisation its single sign-on was linked to, if it ever had one. */
  workosOrgId: string | null;
  /** The WorkOS environment that link belongs to (`organizations.workos_client_id`). */
  workosClientId: string | null;
}

/**
 * Deleted organisations due for purge, oldest deletion first. Those still held
 * back are left out of the answer rather than skipped by the caller, so no
 * number of them can fill the `limit` and starve the rest.
 */
export async function listOrganizationsDueForPurge(
  exec: Executor,
  limit: number,
): Promise<OrganizationDueForPurge[]> {
  return exec
    .select({
      id: organizations.id,
      slug: organizations.slug,
      workosOrgId: organizations.workosOrgId,
      workosClientId: organizations.workosClientId,
    })
    .from(organizations)
    .where(
      and(
        deletedAtLeast(organizations.deletedAt, DELETED_DATA_RETENTION_DAYS),
        not(stillBilled(organizations.id)),
        not(heldByRetainedVault(environmentsOfOrganization(organizations.id))),
      ),
    )
    .orderBy(asc(organizations.deletedAt))
    .limit(limit);
}

export interface PurgedOrganization {
  id: string;
  slug: string;
  projectCount: number;
  environmentCount: number;
  secretCount: number;
}

/**
 * Erases one deleted organisation and everything in it, if it is still due —
 * re-checked here, under the row's lock, since it was listed. `null` when it is
 * not: restored, already purged by a concurrent run, or newly held back.
 *
 * `record` runs inside the transaction, after the delete, so the record that
 * an organisation was erased commits with the erasure or not at all.
 */
export async function purgeOrganization(
  exec: Executor,
  orgId: string,
  record?: (tx: Executor, purged: PurgedOrganization) => Promise<void>,
): Promise<PurgedOrganization | null> {
  return exec.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          deletedAtLeast(organizations.deletedAt, DELETED_DATA_RETENTION_DAYS),
          not(stillBilled(organizations.id)),
          not(heldByRetainedVault(environmentsOfOrganization(organizations.id))),
        ),
      )
      .for('update', { skipLocked: true });
    if (!organization) return null;

    const scope = environmentsOfOrganization(sql`${orgId}::uuid`);
    const [projectRow] = await tx
      .select({ total: count() })
      .from(projects)
      .where(eq(projects.orgId, orgId));
    const purged: PurgedOrganization = {
      ...organization,
      projectCount: projectRow?.total ?? 0,
      environmentCount: await countEnvironments(tx, scope),
      secretCount: await countSecrets(tx, scope),
    };

    await eraseEnvironmentContents(tx, scope);
    // Environments, tokens and access grants cascade from their projects.
    await tx.delete(projects).where(eq(projects.orgId, orgId));
    // Last of the keys: every env_keys row that pointed at these is gone.
    await tx.delete(orgKeys).where(eq(orgKeys.orgId, orgId));
    await tx
      .delete(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          deletedAtLeast(organizations.deletedAt, DELETED_DATA_RETENTION_DAYS),
        ),
      );

    await record?.(tx, purged);
    return purged;
  });
}

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * Deleted projects due for purge, oldest deletion first, held-back ones left
 * out. Whatever state the organisation is in: a project's thirty days run from
 * its own deletion, and restoring the project would not bring back one deleted
 * before it.
 */
export async function listProjectsDueForPurge(exec: Executor, limit: number): Promise<string[]> {
  const rows = await exec
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        deletedAtLeast(projects.deletedAt, DELETED_DATA_RETENTION_DAYS),
        not(heldByRetainedVault(environmentsOfProject(projects.id))),
      ),
    )
    .orderBy(asc(projects.deletedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

export interface PurgedProject {
  id: string;
  orgId: string;
  slug: string;
  environmentCount: number;
  secretCount: number;
}

/** Erases one deleted project and its environments, if still due. See {@link purgeOrganization}. */
export async function purgeProject(
  exec: Executor,
  projectId: string,
  record?: (tx: Executor, purged: PurgedProject) => Promise<void>,
): Promise<PurgedProject | null> {
  return exec.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id, orgId: projects.orgId, slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          deletedAtLeast(projects.deletedAt, DELETED_DATA_RETENTION_DAYS),
          not(heldByRetainedVault(environmentsOfProject(projects.id))),
        ),
      )
      .for('update', { skipLocked: true });
    if (!project) return null;

    const scope = environmentsOfProject(sql`${projectId}::uuid`);
    const purged: PurgedProject = {
      ...project,
      environmentCount: await countEnvironments(tx, scope),
      secretCount: await countSecrets(tx, scope),
    };

    await eraseEnvironmentContents(tx, scope);
    // Its environments go with it, in one statement — so an environment that
    // inherits from another in the same project never outlives its parent.
    await tx
      .delete(projects)
      .where(
        and(
          eq(projects.id, projectId),
          deletedAtLeast(projects.deletedAt, DELETED_DATA_RETENTION_DAYS),
        ),
      );

    await record?.(tx, purged);
    return purged;
  });
}

// ── Environments ────────────────────────────────────────────────────────────

/**
 * Deleted environments due for purge, oldest deletion first, held-back ones
 * left out — including one another environment still names as its parent,
 * which goes once that child has.
 */
export async function listEnvironmentsDueForPurge(
  exec: Executor,
  limit: number,
): Promise<string[]> {
  const rows = await exec
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        deletedAtLeast(environments.deletedAt, DELETED_DATA_RETENTION_DAYS),
        hasNoChildEnvironment(),
        not(heldByRetainedVault(sql`select ${environments.id}`)),
      ),
    )
    .orderBy(asc(environments.deletedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

export interface PurgedEnvironment {
  id: string;
  orgId: string;
  projectId: string;
  projectSlug: string;
  slug: string;
  secretCount: number;
}

/** Erases one deleted environment, if still due. See {@link purgeOrganization}. */
export async function purgeEnvironment(
  exec: Executor,
  environmentId: string,
  record?: (tx: Executor, purged: PurgedEnvironment) => Promise<void>,
): Promise<PurgedEnvironment | null> {
  return exec.transaction(async (tx) => {
    const [environment] = await tx
      .select({
        id: environments.id,
        orgId: projects.orgId,
        projectId: projects.id,
        projectSlug: projects.slug,
        slug: environments.slug,
      })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(environments.id, environmentId),
          deletedAtLeast(environments.deletedAt, DELETED_DATA_RETENTION_DAYS),
          hasNoChildEnvironment(),
          not(heldByRetainedVault(sql`select ${environments.id}`)),
        ),
      )
      .for('update', { of: environments, skipLocked: true });
    if (!environment) return null;

    const scope = sql`select ${environmentId}::uuid`;
    const purged: PurgedEnvironment = {
      ...environment,
      secretCount: await countSecrets(tx, scope),
    };

    await eraseEnvironmentContents(tx, scope);
    await tx
      .delete(environments)
      .where(
        and(
          eq(environments.id, environmentId),
          deletedAtLeast(environments.deletedAt, DELETED_DATA_RETENTION_DAYS),
        ),
      );

    await record?.(tx, purged);
    return purged;
  });
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/** An organisation holding secrets deleted at least thirty days ago, and how long it keeps them. */
export interface OrganizationWithDeletedSecrets {
  orgId: string;
  /** {@link deletedSecretRetentionDays} for its current plan. */
  retentionDays: number;
}

/**
 * Every organisation with a secret deleted thirty or more days ago, in id
 * order, a page at a time after `afterOrgId`. Whether those secrets are due
 * yet depends on the organisation's plan, which is resolved here from the same
 * row, by the same function, as on every request.
 */
export async function listOrganizationsWithDeletedSecrets(
  exec: Executor,
  options: { limit: number; afterOrgId?: string | undefined },
): Promise<OrganizationWithDeletedSecrets[]> {
  const rows = await exec
    .selectDistinct({ orgId: projects.orgId, ...entitlementColumns })
    .from(secrets)
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, projects.orgId))
    .where(
      and(
        deletedAtLeast(secrets.deletedAt, DELETED_DATA_RETENTION_DAYS),
        options.afterOrgId === undefined ? undefined : gt(projects.orgId, options.afterOrgId),
      ),
    )
    .orderBy(asc(projects.orgId))
    .limit(options.limit);

  return rows.map((row) => ({
    orgId: row.orgId,
    // A missing subscription row resolves to Free, as it does everywhere.
    retentionDays: deletedSecretRetentionDays(
      entitlementsFromRow(
        row.plan === null ||
          row.status === null ||
          row.addonSaml === null ||
          row.addonDirectorySync === null
          ? null
          : {
              plan: row.plan,
              status: row.status,
              addonSaml: row.addonSaml,
              addonDirectorySync: row.addonDirectorySync,
              limitOverrides: row.limitOverrides,
              currentPeriodEnd: row.currentPeriodEnd,
            },
      ),
    ),
  }));
}

export interface PurgedSecret {
  id: string;
  name: string;
  environmentId: string;
  environmentSlug: string;
  projectId: string;
  projectSlug: string;
}

/**
 * Erases up to `limit` of one organisation's deleted secrets that have been
 * deleted for at least `retentionDays`, with every version of each. The
 * organisation's environments and keys are untouched: the secrets around them
 * are still in use.
 */
export async function purgeDeletedSecrets(
  exec: Executor,
  params: { orgId: string; retentionDays: number; limit: number },
  record?: (tx: Executor, purged: readonly PurgedSecret[]) => Promise<void>,
): Promise<PurgedSecret[]> {
  assertRetention(params.retentionDays);
  return exec.transaction(async (tx) => {
    const doomed = await tx
      .select({
        id: secrets.id,
        name: secrets.name,
        environmentId: secrets.environmentId,
        environmentSlug: environments.slug,
        projectId: projects.id,
        projectSlug: projects.slug,
      })
      .from(secrets)
      .innerJoin(environments, eq(environments.id, secrets.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(projects.orgId, params.orgId),
          deletedAtLeast(secrets.deletedAt, params.retentionDays),
        ),
      )
      .orderBy(asc(secrets.deletedAt))
      .limit(params.limit)
      .for('update', { of: secrets, skipLocked: true });
    if (doomed.length === 0) return [];

    await tx.delete(secrets).where(
      and(
        inArray(
          secrets.id,
          doomed.map((secret) => secret.id),
        ),
        deletedAtLeast(secrets.deletedAt, params.retentionDays),
      ),
    );

    await record?.(tx, doomed);
    return doomed;
  });
}
