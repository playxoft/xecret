import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DeclaredReference } from '@xecret/core/references';
import { environments, projects } from '../schema/resources';
import { secrets, secretVersions } from '../schema/secrets';
import { serviceTokens } from '../schema/tokens';
import { withinOrganization } from './environments';
import type { EnvironmentRecord } from './environments';
import { RepositoryError } from './shared';
import type { Executor } from './shared';

/**
 * The reference graph's storage half (P19 §1): what the server reads to check a
 * template, an inheritance change or a deletion before it is stored, and to
 * decide which ciphertexts a pull carries.
 *
 * ── No ciphertext, anywhere in this file ──
 * The graph is names, slugs, value types and declared references — plaintext
 * metadata about ciphertext, never the ciphertext. That is a property worth
 * keeping greppable: `secrets.ts` names the four functions that return a value
 * blob, and none of them is here. A check that needed to read a value would be
 * a check the server cannot perform, and the design depends on never needing
 * one.
 *
 * ── Tenancy ──
 * Every query joins `projects` and filters on `org_id`, as everywhere in this
 * package (threat T2). A reference names environments by slug; resolving those
 * slugs here, inside the organisation, is what stops a template pointing into
 * another tenant's environment however its text is written.
 */

/** An environment as the graph needs it: identity, place, parent and mode. */
export interface GraphEnvironmentRecord {
  id: string;
  projectId: string;
  projectSlug: string;
  slug: string;
  parentEnvironmentId: string | null;
  encryptionMode: string;
  isProduction: boolean;
}

/** One live secret's current version, as metadata. */
export interface GraphSecretRecord {
  secretId: string;
  environmentId: string;
  name: string;
  valueType: string;
  version: number;
  declaredReferences: DeclaredReference[] | null;
}

const ENVIRONMENT_COLUMNS = {
  id: environments.id,
  projectId: environments.projectId,
  projectSlug: projects.slug,
  slug: environments.slug,
  parentEnvironmentId: environments.parentEnvironmentId,
  encryptionMode: environments.encryptionMode,
  isProduction: environments.isProduction,
};

function liveEnvironmentsOf(orgId: string): SQL | undefined {
  return and(eq(projects.orgId, orgId), isNull(environments.deletedAt), isNull(projects.deletedAt));
}

/** Every live environment of the named projects. */
export async function loadEnvironmentsOfProjects(
  exec: Executor,
  orgId: string,
  projectIds: readonly string[],
): Promise<GraphEnvironmentRecord[]> {
  if (projectIds.length === 0) return [];
  return exec
    .select(ENVIRONMENT_COLUMNS)
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(inArray(environments.projectId, [...projectIds]), liveEnvironmentsOf(orgId)))
    .orderBy(asc(environments.id));
}

/** Live environments by id. A missing or deleted id is simply absent from the answer. */
export async function loadEnvironmentsByIds(
  exec: Executor,
  orgId: string,
  environmentIds: readonly string[],
): Promise<GraphEnvironmentRecord[]> {
  if (environmentIds.length === 0) return [];
  return exec
    .select(ENVIRONMENT_COLUMNS)
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(inArray(environments.id, [...environmentIds]), liveEnvironmentsOf(orgId)))
    .orderBy(asc(environments.id));
}

/**
 * Resolves `(projectSlug, environmentSlug)` pairs to live environments.
 *
 * What a qualified reference in a template is turned into at write time. A pair
 * that names nothing in this organisation is absent from the answer, and the
 * caller refuses the write: a dangling reference is a validation error, not an
 * outage at the next `xecret run`.
 */
export async function findEnvironmentsBySlugs(
  exec: Executor,
  orgId: string,
  pairs: readonly { projectSlug: string; environmentSlug: string }[],
): Promise<GraphEnvironmentRecord[]> {
  if (pairs.length === 0) return [];
  return exec
    .select(ENVIRONMENT_COLUMNS)
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        liveEnvironmentsOf(orgId),
        or(
          ...pairs.map((pair) =>
            and(eq(projects.slug, pair.projectSlug), eq(environments.slug, pair.environmentSlug)),
          ),
        ),
      ),
    );
}

/**
 * The current version of every live secret in the named environments, as
 * metadata — one `DISTINCT ON`, the same shape as the bulk read, minus the
 * bytes.
 */
export async function loadSecretGraphMetadata(
  exec: Executor,
  orgId: string,
  environmentIds: readonly string[],
): Promise<GraphSecretRecord[]> {
  if (environmentIds.length === 0) return [];
  return exec
    .selectDistinctOn([secretVersions.secretId], {
      secretId: secrets.id,
      environmentId: secrets.environmentId,
      name: secrets.name,
      valueType: secrets.valueType,
      version: secretVersions.version,
      declaredReferences: secretVersions.declaredReferences,
    })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        inArray(secrets.environmentId, [...environmentIds]),
        isNull(secrets.deletedAt),
        liveEnvironmentsOf(orgId),
      ),
    )
    .orderBy(asc(secretVersions.secretId), desc(secretVersions.version));
}

/**
 * The projects holding a *current* template that points into any of `targets`.
 *
 * Asked before anything a reference could be pointing at is removed or
 * re-parented, so that the check can load exactly the projects whose views the
 * change can break. Containment on the GIN index finds candidate versions;
 * "current" is checked against the highest version of each secret, because a
 * template's old version pointing somewhere is history, not a dependency.
 */
export async function findProjectsReferencingEnvironments(
  exec: Executor,
  orgId: string,
  targets: readonly string[],
): Promise<string[]> {
  if (targets.length === 0) return [];

  const contains = targets.map(
    (environmentId) =>
      sql`${secretVersions.declaredReferences} @> ${JSON.stringify([{ environmentId }])}::jsonb`,
  );

  const rows = await exec
    .selectDistinct({ projectId: environments.projectId })
    .from(secretVersions)
    .innerJoin(secrets, eq(secrets.id, secretVersions.secretId))
    .innerJoin(environments, eq(environments.id, secrets.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        liveEnvironmentsOf(orgId),
        isNull(secrets.deletedAt),
        sql`${secretVersions.declaredReferences} is not null`,
        or(...contains),
        sql`${secretVersions.version} = (
          select max(latest.version) from ${secretVersions} as latest
          where latest.secret_id = ${secretVersions.secretId}
        )`,
      ),
    );

  return rows.map((row) => row.projectId);
}

/** Environments that name this one as their parent. */
export async function listChildEnvironments(
  exec: Executor,
  orgId: string,
  environmentId: string,
): Promise<{ id: string; slug: string }[]> {
  return exec
    .select({ id: environments.id, slug: environments.slug })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(environments.parentEnvironmentId, environmentId), liveEnvironmentsOf(orgId)))
    .orderBy(asc(environments.slug));
}

/**
 * How many usable service tokens are pinned to any of these environments:
 * not revoked, not expired.
 *
 * A service token is pinned to one environment and can read no other (threat
 * T5), so it cannot resolve an inherited layer or a reference into another
 * environment. The rule that keeps that from becoming an outage is checked at
 * write time with this count: an environment CI reads from may not be given a
 * parent or a cross-environment reference, and an environment that has either
 * may not be given a service token.
 */
export async function countUsableServiceTokens(
  exec: Executor,
  orgId: string,
  environmentIds: readonly string[],
): Promise<number> {
  if (environmentIds.length === 0) return 0;
  const [row] = await exec
    .select({ total: count() })
    .from(serviceTokens)
    .where(
      and(
        eq(serviceTokens.orgId, orgId),
        inArray(serviceTokens.environmentId, [...environmentIds]),
        isNull(serviceTokens.revokedAt),
        or(isNull(serviceTokens.expiresAt), gt(serviceTokens.expiresAt, sql`now()`)),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Sets or clears an environment's parent.
 *
 * The composite foreign key keeps the parent in the same project and the CHECK
 * keeps it from being the environment itself; everything longer — a loop, a
 * chain past five, a view a template can no longer resolve in — is the caller's
 * to refuse first, from the graph.
 */
export async function setEnvironmentParent(
  exec: Executor,
  orgId: string,
  environmentId: string,
  parentEnvironmentId: string | null,
): Promise<EnvironmentRecord> {
  const [row] = await exec
    .update(environments)
    .set({ parentEnvironmentId, updatedAt: sql`now()` })
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
