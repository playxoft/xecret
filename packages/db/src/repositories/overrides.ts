import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@xecret/core/ids';
import { personalOverrides } from '../schema/paid-features';
import { environments, projects } from '../schema/resources';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * Personal overrides (P19 §2, migration 0029).
 *
 * Every function here is scoped by **owner** as well as by organisation and
 * environment: there is no read in this file that returns somebody else's
 * override, and no caller can ask for one by id. That is the storage half of
 * "never visible to another member"; the ciphertext being under the owner's
 * own key (spec §2.2 type 13) is the cryptographic half.
 */

/** How many overrides one person may hold in one environment. */
export const MAX_OVERRIDES_PER_ENVIRONMENT = 100;

export interface OverrideRecord {
  id: string;
  name: string;
  /** The ASCII of the `xk2.gcm.` blob. */
  ciphertext: Uint8Array;
  createdAt: Date;
  updatedAt: Date;
}

export interface OverrideOwner {
  orgId: string;
  environmentId: string;
  userId: string;
}

const COLUMNS = {
  id: personalOverrides.id,
  name: personalOverrides.name,
  ciphertext: personalOverrides.ciphertext,
  createdAt: personalOverrides.createdAt,
  updatedAt: personalOverrides.updatedAt,
};

/** The environment, reached through its project and organisation, still live. */
function liveEnvironment(orgId: string, environmentId: string) {
  return sql`exists (
    select 1 from ${environments}
    inner join ${projects} on ${projects.id} = ${environments.projectId}
    where ${environments.id} = ${environmentId}
      and ${projects.orgId} = ${orgId}
      and ${environments.deletedAt} is null
      and ${projects.deletedAt} is null
  )`;
}

function ownedBy(owner: OverrideOwner) {
  return and(
    eq(personalOverrides.orgId, owner.orgId),
    eq(personalOverrides.environmentId, owner.environmentId),
    eq(personalOverrides.userId, owner.userId),
  );
}

/** One person's overrides in one environment, by name. */
export async function listOverrides(
  exec: Executor,
  owner: OverrideOwner,
): Promise<OverrideRecord[]> {
  return exec
    .select(COLUMNS)
    .from(personalOverrides)
    .where(and(ownedBy(owner), liveEnvironment(owner.orgId, owner.environmentId)))
    .orderBy(asc(personalOverrides.name));
}

/**
 * Sets an override, replacing the one already held under that name.
 *
 * Refuses a new name past {@link MAX_OVERRIDES_PER_ENVIRONMENT} with
 * `quotaExceeded`, and an environment outside the organisation with `notFound` —
 * checked inside the transaction that writes, so neither can be raced past.
 */
export async function upsertOverride(
  exec: Executor,
  params: OverrideOwner & { name: string; ciphertext: Uint8Array },
): Promise<{ record: OverrideRecord; created: boolean }> {
  return exec.transaction(async (tx) => {
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
      throw new RepositoryError('notFound', `Environment ${params.environmentId} not found`);
    }

    const [existing] = await tx
      .select({ id: personalOverrides.id })
      .from(personalOverrides)
      .where(and(ownedBy(params), eq(personalOverrides.name, params.name)))
      .limit(1);

    if (existing === undefined) {
      const [held] = await tx
        .select({ total: count() })
        .from(personalOverrides)
        .where(ownedBy(params));
      if ((held?.total ?? 0) >= MAX_OVERRIDES_PER_ENVIRONMENT) {
        throw new RepositoryError(
          'quotaExceeded',
          `At most ${MAX_OVERRIDES_PER_ENVIRONMENT} personal overrides per environment.`,
        );
      }
    }

    const [record] = await tx
      .insert(personalOverrides)
      .values({
        id: uuidv7(),
        orgId: params.orgId,
        environmentId: params.environmentId,
        userId: params.userId,
        name: params.name,
        ciphertext: params.ciphertext,
      })
      .onConflictDoUpdate({
        target: [personalOverrides.environmentId, personalOverrides.userId, personalOverrides.name],
        set: { ciphertext: params.ciphertext, updatedAt: sql`now()` },
      })
      .returning(COLUMNS);

    if (!record) throw new RepositoryError('conflict', 'The override could not be written.');
    return { record, created: existing === undefined };
  });
}

/** Removes one override. Answers whether there was one. */
export async function deleteOverride(
  exec: Executor,
  params: OverrideOwner & { name: string },
): Promise<OverrideRecord | null> {
  const [row] = await exec
    .delete(personalOverrides)
    .where(and(ownedBy(params), eq(personalOverrides.name, params.name)))
    .returning(COLUMNS);
  return row ?? null;
}

/**
 * Removes every override a person holds in an organisation — what a member's
 * removal does in the same transaction, so a removed member's local values do
 * not outlive their access.
 */
export async function deleteOverridesForMember(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<number> {
  const rows = await exec
    .delete(personalOverrides)
    .where(and(eq(personalOverrides.orgId, orgId), eq(personalOverrides.userId, userId)))
    .returning({ id: personalOverrides.id });
  return rows.length;
}
